"""Reads a recipe pasted in as text into a draft for the form.

The text comes from wherever the recipe was kept: a note typed on a phone, a
text file, an answer from an AI chat, a recipe card copied out of a browser.
None of them carries the schema.org data a link import reads, so this goes by
how recipes are written down instead. Headings in any of the usual styles
divide the text into ingredients, steps and notes; labelled lines ("Prep
time: 15 minutes", "Serves 4", "Source: ...") fill in the details; and where
there are no headings at all, a line that starts with an amount is an
ingredient.

Rules rather than a model, so the same text always reads the same way, nothing
leaves the server, and a wrong reading can be traced to the rule that made it.

Ingredient lines go through the link importer's own parser, so a pasted
recipe's rows behave exactly like an imported one's and keep their line. Tags
and servings are reasoned about by the importer's functions too, for the same
reason.

What comes back is a draft, as with a link import: the person reviews it in
the form and nothing is saved until they do. What could not be found is named
on the draft, so the form can say so rather than leave a blank to be noticed.
"""

import re
import unicodedata
from collections.abc import Collection
from dataclasses import dataclass, field
from typing import Literal

from pydantic import HttpUrl

from ..schemas import PastedRecipeDraft, RecipePart
from .list_marks import read_list_marks
from .recipe_import import (
    UNICODE_FRACTIONS,
    parse_ingredient_line,
    parse_servings,
    suggest_tags,
    tag_names,
)

# Longer than any recipe written out in full, story and notes included, and
# short enough that pasting a whole web page - comments and all - is refused
# rather than read into a form nobody could review.
MAX_TEXT_CHARACTERS = 50_000

# The longest line taken for a title. A title is a name, and a first line
# longer than this is the start of a paragraph.
_TITLE_LENGTH = 80


class UnreadableText(Exception):
    """The text cannot be read as a recipe at all: it is empty, or too long to
    be one. Said in words the form can show as they are."""


_Kind = Literal["pre", "ingredients", "instructions", "notes", "nutrition"]

# Headings, by what they head. Notes are kept, at the end of the description,
# so nothing written down is lost; that is why storage, swaps and serving
# ideas are notes too, rather than headings to read past. Nutrition is left
# out, because the app works nutrition out from the ingredients itself.
_SECTIONS: dict[str, _Kind] = {
    **dict.fromkeys(
        [
            "ingredients",
            "ingredient list",
            "ingredients list",
            "what you'll need",
            "what you need",
            "you'll need",
            "you will need",
        ],
        "ingredients",
    ),
    **dict.fromkeys(
        [
            "instructions",
            "directions",
            "method",
            "steps",
            "preparation",
            "procedure",
            "how to make it",
            "how to make",
            "cooking instructions",
        ],
        "instructions",
    ),
    **dict.fromkeys(
        [
            "notes",
            "note",
            "tips",
            "tip",
            "recipe notes",
            "cook's notes",
            "chef's notes",
            "notes and tips",
            "tips and notes",
            "tips and tricks",
            "variations",
            "substitutions",
            "storage",
            "make ahead",
            "make-ahead",
            "serving suggestions",
            "equipment",
        ],
        "notes",
    ),
    **dict.fromkeys(
        [
            "nutrition",
            "nutrition facts",
            "nutrition information",
            "nutritional information",
            "nutrition info",
        ],
        "nutrition",
    ),
}
_SECTION_NAME = "|".join(re.escape(name) for name in sorted(_SECTIONS, key=len, reverse=True))
# A heading may qualify its name: "Ingredients for the dough", "Notes on
# storage". Only a line written as a heading gets that latitude; a bare line
# has to be the name, or the name "for" or "per" something, so a sentence
# that opens with "Steps" or "Method" is not taken for one.
_STYLED_SECTION = re.compile(rf"^(?P<name>{_SECTION_NAME})(?:\s+.{{1,30}})?$")
_BARE_SECTION = re.compile(rf"^(?P<name>{_SECTION_NAME})(?:\s+(?:for|per)\s+.{{1,24}})?$")

# Labelled details. Times and servings may follow their label with no colon
# ("Serves 4", "Prep Time 10 mins"); tags and the lines left out need one,
# so "Course" in a sentence is not taken for a label.
_DETAIL_LABELS = {
    "prep": r"prep(?:aration)?(?:\s+time)?",
    "cook": r"(?:cook(?:ing)?|bake|baking)(?:\s+time)?",
    "total": r"total(?:\s+cook(?:ing)?)?(?:\s+time)?|ready\s+in",
    "servings": r"servings?|serves|yields?|makes",
    "tags": r"course|cuisine|category|categories|tags?",
    "keywords": r"keywords?",
    # Recipe cards show these beside the times; neither is anything the
    # recipe box keeps, and left in they would read as the description.
    "skip": r"calories|author",
}
_ANY_LABEL = "|".join(_DETAIL_LABELS.values())
_DETAIL = re.compile(
    "^(?:"
    + "|".join(f"(?P<{kind}>{label})" for kind, label in _DETAIL_LABELS.items())
    + r")(?P<sep>\s*[:\-–]\s*|\s+)(?P<value>\S.*)$",
    re.IGNORECASE,
)
_LABEL_ONLY = re.compile(rf"^(?P<label>{_ANY_LABEL})\s*:?$", re.IGNORECASE)
# Recipe cards set their details side by side, and copied they run on:
# "Prep Time 10 mins Cook Time 25 mins Servings 4". A label that follows a
# word starts the next detail.
_RUN_ON = re.compile(rf"(?<=[a-z])\s+(?=(?:{_ANY_LABEL})\b)", re.IGNORECASE)
_DETAIL_SEPARATOR = re.compile(r"\s*[|•·]\s*")
_SERVINGS_VALUE = re.compile(r"^(?:about|approx\.?|approximately|around|up to|~)?\s*\d", re.I)

_FRACTIONS = "".join(UNICODE_FRACTIONS)
_NUMBER = rf"\d+/\d+|\d+(?:\.\d+)?(?:\s+\d+/\d+|\s*[{_FRACTIONS}])?|[{_FRACTIONS}]"
_TIME_UNIT = r"days?|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s"
_RANGE = r"\s*(?:-|–|to)\s*"
_TIME_PART_SHAPE = rf"(?:{_NUMBER})(?:{_RANGE}(?:{_NUMBER}))?\s*(?:{_TIME_UNIT})(?![a-z])\.?"
_DURATION = re.compile(rf"{_TIME_PART_SHAPE}(?:\s*(?:,|and|\+)?\s*{_TIME_PART_SHAPE})*")
_TIME_PART = re.compile(
    rf"(?P<low>{_NUMBER})(?:{_RANGE}(?P<high>{_NUMBER}))?\s*(?P<unit>{_TIME_UNIT})(?![a-z])"
)
_MINUTES_PER = {"d": 1440, "h": 60, "m": 1, "s": 1 / 60}

_TITLE_LABEL = re.compile(r"^(?:title|recipe(?:\s+name)?)\s*:\s*(?P<value>\S.*)$", re.IGNORECASE)
_SOURCE_LABEL = re.compile(
    r"^(?:source|from|original(?:\s+recipe)?|adapted\s+from|recipe\s+(?:from|source)|link|url)"
    r"\s*:",
    re.IGNORECASE,
)
_URL = re.compile(r"https?://[^\s<>()\[\]\"']+")

# What a recipe card's buttons and stars copy as.
_CARD_BUTTON = re.compile(
    r"^(?:print|pin|save|share|rate|email|jump to)(?:\s+this)?(?:\s+(?:recipe|video))?$", re.I
)
_RATING = re.compile(
    r"^\d(?:\.\d+)?\s+(?:from|stars?\s+from)\s+\d+\s+(?:votes?|reviews?|ratings?)$"
    r"|^\(?\d+\s+(?:votes?|reviews?|ratings?)\)?$",
    re.I,
)

# How an AI chat opens and closes an answer. The opener is dropped wherever it
# stands before the recipe; the sign-off only when it closes the text.
_OPENER = re.compile(
    r"^(?:(?:sure|certainly|absolutely|of course|okay|ok|great|happy to help)[!,.:]"
    r"|here(?:['’]s|\s+is|\s+are)\b|below\s+(?:is|are)\b)",
    re.I,
)
_SIGN_OFF = re.compile(
    r"^(?:enjoy|let me know|happy (?:cooking|baking|eating)|bon app[ée]tit|buon appetito"
    r"|i hope|hope you|feel free|would you like|do you want|want me to"
    r"|if you(?:['’]d|\s+would)\s+like|i can also|i could also|i['’]d be happy|have fun)\b",
    re.I,
)

_ATX = re.compile(r"^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$")
_BOLD_LINE = re.compile(r"^(\*\*|__)(?!\s)(?P<inner>(?:(?!\1).)+?)\1\s*:?$")
_RULE = re.compile(r"^(?:[-*_=]\s*){3,}$")
_QUOTE = re.compile(r"^(?:>\s?)+")
# Neither reaches past the next mark of its own kind: emphasis does not nest
# in practice, and letting it would make a long line of stray underscores
# take seconds to read.
_MD_LINK = re.compile(r"!?\[([^\[\]]*)\]\([^()\s]*\)")
_PARENTHETICAL = re.compile(r"\([^()]*\)")
_EMPHASIS = re.compile(
    r"(?<![\w*])\*(?=[^\s*])([^*]+?)(?<=\S)\*(?![\w*])"
    r"|(?<![\w_])_(?=[^\s_])([^_]+?)(?<=\S)_(?![\w_])"
)
_MD_ESCAPE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!])")
# "Step 1", "Step 2:", "STEP 3 -": a recipe card's step numbering, which marks
# where a step starts just as a list number does.
_STEP = re.compile(r"^(?i:step)\s*\d+(?:\s*[.:)\-–]\s*|\s*$|\s+(?=[A-Z]))")
# A group label inside a list: "For the sauce", "To make the glaze".
_GROUP = re.compile(r"^(?:for|to make)\s+(?:the\s+)?[^.,:;!?]{1,30}$", re.I)
_AMOUNT = re.compile(rf"^(?:\d|[{_FRACTIONS}])")
_SENTENCE_END = re.compile(r"[.!?…][\"'”’)\]]*$")
_INVISIBLE = dict.fromkeys(map(ord, "\u200b\u200c\u2060\ufeff"))


@dataclass
class _Line:
    """A non-blank line, its decoration read off.

    `marked` is a line that opened with a bullet, a number, a box or "Step
    1", which is where a list item starts. `level` is the Markdown heading
    level, if it was one. `styled` is a line written as a heading in any of
    the ways people write one: a Markdown heading, a line in bold, or a short
    line ending in a colon. `url` is the first link in it, found before the
    Markdown around it is taken off.
    """

    text: str
    indent: int = 0
    marked: bool = False
    level: int | None = None
    styled: bool = False
    url: str | None = None
    # A one-line note such as "Note: bread flour works too", which belongs
    # with the notes wherever it stands.
    aside: bool = False


@dataclass
class _Region:
    kind: _Kind
    # The heading as written, which labels a notes section in the description.
    label: str | None = None
    # The Markdown level of the heading that opened it, if it was one.
    level: int | None = None
    lines: list[_Line | None] = field(default_factory=list)


@dataclass
class _Details:
    title: str | None = None
    source: str | None = None
    prep: int | None = None
    cook: int | None = None
    total: int | None = None
    servings: int | None = None
    described: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)

    def take(self, kind: str, value: object) -> None:
        if kind in ("prep", "cook", "total", "servings"):
            if getattr(self, kind) is None:
                setattr(self, kind, value)
        elif kind == "tags":
            self.described.extend(value)  # type: ignore[arg-type]
        elif kind == "keywords":
            self.keywords.extend(value)  # type: ignore[arg-type]


def read_recipe_text(text: str, known_tags: Collection[str] = ()) -> PastedRecipeDraft:
    """The recipe in `text`, as a draft for the form.

    `known_tags` are the tags already in the recipe box, which the suggested
    tags are spelled against, as for a link import. Raises UnreadableText for
    text that is empty or longer than any recipe.
    """
    if len(text) > MAX_TEXT_CHARACTERS:
        raise UnreadableText(
            f"That text is too long to be one recipe. Paste just the recipe, up to"
            f" {MAX_TEXT_CHARACTERS:,} characters."
        )
    if not text.strip():
        raise UnreadableText("There is no text to read. Paste a recipe first.")

    regions, details = _divide(_without_sign_off(_lines(text)))
    has_ingredients = any(r.kind == "ingredients" for r in regions)
    has_instructions = any(r.kind == "instructions" for r in regions)

    title = details.title or ""
    description: list[str] = []
    ingredients: list[str] = []
    steps: list[str] = []
    notes: list[tuple[str | None, list[str]]] = []

    for region in regions:
        asides = [line for line in region.lines if line is not None and line.aside]
        notes.extend((None, [line.text]) for line in asides)
        lines = [line for line in region.lines if line is None or not line.aside]
        if region.kind == "pre":
            lines = [line for line in lines if line is None or not _OPENER.match(line.text)]
            if not title:
                # A labelled title says nothing about where the recipe starts,
                # so no line before it is taken for a chat's opening.
                title, lines = _title(lines)
            if has_ingredients:
                description = _items(lines, headings=True)
            else:
                lead, listed, rest = _split_bare(lines, steps_follow=has_instructions)
                description = _items(lead, headings=True)
                ingredients.extend(listed)
                steps.extend(_items(rest, headings=False))
        elif region.kind == "ingredients":
            listed, rest = _ingredients(lines, steps_follow=has_instructions)
            ingredients.extend(listed)
            steps.extend(_items(rest, headings=False))
        elif region.kind == "instructions":
            steps.extend(_items(lines, headings=False))
        elif region.kind == "notes":
            notes.append((region.label, _items(lines, headings=True)))

    cook = details.cook
    if cook is None and details.total is not None:
        cook = max(details.total - (details.prep or 0), 0) or None

    parsed = [parse_ingredient_line(line) for line in ingredients if _names_something(line)]
    missing: list[RecipePart] = []
    if not title:
        missing.append("title")
    if not parsed:
        missing.append("ingredients")
    if not steps:
        missing.append("instructions")

    return PastedRecipeDraft(
        title=title[:200],
        description=_description(description, notes),
        instructions="\n".join(steps),
        prep_minutes=details.prep,
        cook_minutes=cook,
        servings=details.servings,
        ingredients=parsed,
        tags=suggest_tags(details.described, details.keywords, known_tags),
        source_url=details.source,
        missing=missing,
    )


# ----------------------------------------------------------------- lines ---


def _plain(text: str) -> str:
    """The words without their Markdown: links to their text, emphasis and
    code marks off, escapes undone, runs of space made one."""
    text = _MD_LINK.sub(r"\1", text)
    text = text.replace("**", "").replace("__", "")
    text = _EMPHASIS.sub(lambda m: m.group(1) or m.group(2), text)
    text = _MD_ESCAPE.sub(r"\1", text.replace("`", ""))
    return " ".join(text.split())


def _lines(text: str) -> list[_Line | None]:
    """Every line of the text, read; None for a blank line, or for a rule,
    which separates the same way."""
    lines: list[_Line | None] = []
    for raw in text.translate(_INVISIBLE).replace("\u00a0", " ").splitlines():
        raw = raw.replace("\t", "    ")
        # A Markdown quote, which AI answers put tips in, reads as its words.
        stripped = _QUOTE.sub("", raw.strip())
        if not stripped or _RULE.match(stripped):
            lines.append(None)
            continue
        line = _Line(text="", indent=len(raw) - len(raw.lstrip()))
        heading = _ATX.match(stripped)
        if heading:
            line.level = len(heading.group(1))
            stripped = heading.group(2)
        else:
            marks = read_list_marks(stripped)
            stripped, line.marked = marks.text, marks.marked
        bold = not line.marked and _BOLD_LINE.match(stripped) is not None
        url = _URL.search(stripped)
        line.url = url.group().rstrip(".,;:!?") if url else None
        words = _plain(stripped)
        step = _STEP.match(words)
        if step:
            words, line.marked = words[step.end() :].strip(), True
        if not words and not line.marked:
            lines.append(None)
            continue
        line.text = words
        line.styled = (
            line.level is not None
            or bold
            or (words.endswith(":") and ":" not in words[:-1] and len(words) <= 60)
        )
        lines.append(line)
    return lines


def _without_sign_off(lines: list[_Line | None]) -> list[_Line | None]:
    """The text without the chat's closing words ("Enjoy! Let me know if...").

    Only what closes the text, and only when it starts the way a sign-off
    starts, so a last step that ends "...and enjoy!" stays a step.
    """
    lines = list(lines)
    while True:
        while lines and lines[-1] is None:
            lines.pop()
        if not lines:
            return lines
        start = len(lines) - 1
        while start > 0 and lines[start - 1] is not None:
            start -= 1
        first, last = lines[start], lines[-1]
        if _is_sign_off(first):
            del lines[start:]
        elif _is_sign_off(last):
            lines.pop()
        else:
            return lines


def _is_sign_off(line: _Line | None) -> bool:
    return (
        line is not None
        and not line.marked
        and line.level is None
        and _SIGN_OFF.match(line.text) is not None
    )


# ------------------------------------------------------------- dividing ---


def _divide(lines: list[_Line | None]) -> tuple[list[_Region], _Details]:
    """The text cut at its section headings, with the labelled details, the
    title label and the source taken out wherever they stand."""
    details = _Details()
    regions = [_Region("pre")]
    index = 0
    while index < len(lines):
        line = lines[index]
        region = regions[-1]
        index += 1
        if line is None:
            region.lines.append(None)
            continue
        section = _section(line)
        if region.kind == "nutrition":
            # Read past, up to the next section: a nutrition panel's
            # "Serving: 1 cup" is not the recipe's servings.
            if section is not None and not section.lines:
                regions.append(section)
            continue
        if _CARD_BUTTON.match(line.text) or _RATING.match(line.text):
            continue
        source = _source(line)
        if source is not None:
            details.source = details.source or source
            continue
        labelled = _TITLE_LABEL.match(line.text)
        if labelled and line.url is None:
            details.title = details.title or _heading_text(labelled.group("value"))
            continue
        consumed = _take_details(lines, index - 1, details)
        if consumed:
            index += consumed - 1
            continue
        if section is not None:
            if section.kind in ("notes", "nutrition") and section.lines:
                # "Note: bread flour works too" is a note, not the start of
                # a notes section that would take the lines after it too.
                if section.kind == "notes":
                    region.lines.append(_Line(text=line.text, aside=True))
                continue
            regions.append(section)
            continue
        if (
            line.level is not None
            and region.level is not None
            and line.level <= region.level
        ):
            # A heading beside "Instructions" rather than under it, such as
            # "Make it a meal": read past as a sub-heading, its list would be
            # taken for more steps. It is kept as a note, with its heading.
            regions.append(_Region("notes", label=_heading_text(line.text), level=line.level))
            continue
        if line.text.endswith(":") and _OPENER.match(line.text):
            continue  # "Here's what you'll need:"
        region.lines.append(line)
    return regions, details


def _heading_text(text: str) -> str:
    """A heading's words, without the colon after it or the emoji either side."""
    text = text.strip().rstrip(":").strip()

    def decoration(char: str) -> bool:
        return char.isspace() or char in "*_#~:-–" or unicodedata.category(char) in {
            "So", "Sk", "Sm", "Mn", "Cf",
        }

    start, end = 0, len(text)
    while start < end and decoration(text[start]):
        start += 1
    while end > start and decoration(text[end - 1]):
        end -= 1
    return text[start:end]


def _section_name(text: str) -> str:
    name = _heading_text(text).casefold().replace("’", "'").replace("&", "and")
    return " ".join(_PARENTHETICAL.sub(" ", name).split())


def _section(line: _Line) -> _Region | None:
    """The section `line` opens, if it is a section heading.

    "Ingredients: 2 cups flour" opens one too, with its first line already
    in it; for notes and nutrition the line is the whole of it.
    """
    if line.marked:
        return None
    name = _section_name(line.text) if len(line.text) <= 80 else ""
    pattern = _STYLED_SECTION if line.styled else _BARE_SECTION
    match = pattern.match(name) if name else None
    if match:
        return _Region(_SECTIONS[match.group("name")], _heading_text(line.text), line.level)
    label, colon, rest = line.text.partition(":")
    if colon and rest.strip() and line.level is None:
        kind = _SECTIONS.get(_section_name(label))
        if kind is not None:
            content = _Line(text=rest.strip(), url=line.url)
            return _Region(kind, _heading_text(label), lines=[content])
    return None


def _source(line: _Line) -> str | None:
    """The link on a "Source:" line, or on a line that is nothing but a link."""
    if line.url is None:
        return None
    labelled = _SOURCE_LABEL.match(line.text) is not None
    bare = not _URL.sub("", line.text).strip(" <>()[].,;:")
    if not (labelled or bare):
        return None
    try:
        HttpUrl(line.url)
    except ValueError:
        return None
    return line.url


def _take_details(lines: list[_Line | None], index: int, details: _Details) -> int:
    """How many lines from `index` are details, having taken them.

    A recipe card copied out of a browser sets each label on a line of its
    own and its value on the next ("Prep Time" then "10 mins"), so a lone
    label is read with the line after it.
    """
    line = lines[index]
    assert line is not None
    found = _details(line.text)
    if found is not None:
        for kind, value in found:
            details.take(kind, value)
        return 1
    label = _LABEL_ONLY.match(line.text)
    if not label:
        return 0
    following = next(
        (i for i in range(index + 1, len(lines)) if lines[i] is not None), None
    )
    if following is None:
        return 0
    value = lines[following]
    assert value is not None
    if value.marked or value.level is not None or _section(value) is not None:
        return 0
    one = _detail(f"{label.group('label')}: {value.text}")
    if one is None:
        return 0
    details.take(*one)
    return following - index + 1


def _details(text: str) -> list[tuple[str, object]] | None:
    """Every detail on a line that is nothing but details, or None."""
    found: list[tuple[str, object]] = []
    for part in _DETAIL_SEPARATOR.split(text):
        if not part.strip():
            continue
        one = _detail(part)
        if one is not None:
            found.append(one)
            continue
        pieces = _RUN_ON.split(part)
        if len(pieces) == 1:
            return None
        many = [_detail(piece) for piece in pieces]
        if any(item is None for item in many):
            return None
        found.extend(item for item in many if item is not None)
    return found or None


def _detail(part: str) -> tuple[str, object] | None:
    """One "label: value", if the value is what the label promises."""
    match = _DETAIL.match(part.strip())
    if not match:
        return None
    kind = next(k for k in _DETAIL_LABELS if match.group(k) is not None)
    label = match.group(kind).casefold()
    value = match.group("value").strip()
    labelled = match.group("sep").strip() != ""
    if kind in ("prep", "cook", "total"):
        # "Bake 20 minutes." is a step. "Bake time 20 minutes" and "Bake: 20
        # minutes" are what a recipe says about itself.
        if not (labelled or "time" in label or label.startswith("ready")):
            return None
        minutes = _minutes(value)
        return (kind, minutes) if minutes is not None else None
    if kind == "servings":
        if not _SERVINGS_VALUE.match(value) or len(part) > 60:
            return None
        servings = parse_servings(value)
        return (kind, servings) if servings is not None else None
    if not labelled:
        return None
    if kind in ("tags", "keywords"):
        names = tag_names(value)
        return (kind, names) if names else None
    return (kind, None) if len(value) <= 60 else None


def _minutes(text: str) -> int | None:
    """Minutes in "1 hr 20 min", "1½ hours", "25-30 minutes"; None for
    anything that is not just a length of time.

    A range is read as its top: the planner is better off allowing too long
    for dinner than too little, the same reason servings take the larger
    number.
    """
    text = _PARENTHETICAL.sub(" ", text.casefold())
    text = re.sub(r"^\s*(?:about|approx\.?|approximately|around|roughly|~)\s*", "", text)
    text = text.strip().rstrip(".").strip()
    if not _DURATION.fullmatch(text):
        return None
    total = 0.0
    for part in _TIME_PART.finditer(text):
        total += _number(part.group("high") or part.group("low")) * _MINUTES_PER[
            part.group("unit")[0]
        ]
    return round(total) or None


def _number(text: str) -> float:
    total = 0.0
    for piece in re.findall(rf"\d+/\d+|\d+(?:\.\d+)?|[{_FRACTIONS}]", text):
        if piece in UNICODE_FRACTIONS:
            total += UNICODE_FRACTIONS[piece]
        elif "/" in piece:
            numerator, denominator = piece.split("/")
            total += int(numerator) / int(denominator) if int(denominator) else 0
        else:
            total += float(piece)
    return total


# --------------------------------------------------------------- reading ---


def _title(lines: list[_Line | None]) -> tuple[str, list[_Line | None]]:
    """The title among the lines before the first section, and the lines
    after it.

    The first Markdown heading, or the first short line that reads as a name
    rather than a sentence, whichever comes first. A line ending in "!" is
    taken only when nothing else is there, since that is how an AI chat's
    opening line usually ends. What comes before the title is that opening,
    not the recipe, and is dropped.
    """
    content = [(i, line) for i, line in enumerate(lines) if line is not None]

    def name_like(line: _Line) -> bool:
        return (
            not line.marked
            and len(line.text) <= _TITLE_LENGTH
            and not _AMOUNT.match(line.text)
            and not line.text.endswith(":")
        )

    chosen = next(
        (
            i
            for i, line in content
            if line.level is not None
            or (name_like(line) and not re.search(r"[.!?…]$", line.text))
        ),
        next((i for i, line in content if name_like(line) and line.text.endswith("!")), None),
    )
    if chosen is None:
        return "", lines
    title = lines[chosen]
    assert title is not None
    return _heading_text(title.text), lines[chosen + 1 :]


def _reads_as_step(line: _Line) -> bool:
    """A sentence rather than an ingredient: no amount in front, and either a
    full stop at the end or more words than any ingredient line has."""
    if _AMOUNT.match(line.text):
        return False
    return _SENTENCE_END.search(line.text) is not None or len(line.text.split()) > 12


def _is_group_label(line: _Line) -> bool:
    """A sub-heading inside a section: "For the sauce:", "### Sauce", a line
    in bold. Read past, as the link importer reads past a site's groups."""
    if _AMOUNT.match(line.text):
        return False
    return line.styled or (not line.marked and _GROUP.match(line.text) is not None)


def _split_bare(
    lines: list[_Line | None], *, steps_follow: bool
) -> tuple[list[_Line | None], list[str], list[_Line | None]]:
    """Lines under no ingredients heading, as description, ingredients and
    steps.

    A line that starts with an amount is an ingredient, and so is a short one
    among them that is not a sentence ("Salt and pepper, to taste"). What
    comes before the first of them is the description; the first sentence
    after them starts the steps. Text with no ingredients at all is steps,
    unless steps of its own follow under a heading, when it is description.
    """
    first = next(
        (
            i
            for i, line in enumerate(lines)
            if line is not None and not line.styled and _AMOUNT.match(line.text)
        ),
        None,
    )
    if first is None:
        return (lines, [], []) if steps_follow else ([], [], lines)
    listed, rest = _ingredients(lines[first:], steps_follow=False)
    return lines[:first], listed, rest


def _ingredients(
    lines: list[_Line | None], *, steps_follow: bool
) -> tuple[list[str], list[_Line | None]]:
    """The ingredient lines, and whatever follows them that reads as steps.

    Steps are looked for only when the text has no steps heading of its own:
    a note with "Ingredients:" and then its method straight after.
    """
    listed: list[str] = []
    previous: _Line | None = None
    for index, line in enumerate(lines):
        if line is None:
            previous = None
            continue
        if _is_group_label(line):
            previous = None
            continue
        if not steps_follow and not line.marked and _reads_as_step(line):
            return listed, lines[index:]
        if (
            previous is not None
            and previous.marked
            and not line.marked
            and line.indent > previous.indent
        ):
            listed[-1] += " " + line.text  # a wrapped line
            continue
        listed.append(line.text)
        previous = line
    return listed, []


def _items(lines: list[_Line | None], *, headings: bool) -> list[str]:
    """One string per step, note or paragraph.

    An item starts at each list mark, and a wrapped line or an indented
    paragraph after one belongs to it. Unmarked text is one item per
    paragraph where blank lines separate paragraphs, and one per line where
    they do not, which is how a recipe card's steps copy - except a line that
    plainly carries on the one before, a hard-wrapped sentence.

    With `headings`, a heading among them is kept as a label ending in a
    colon, as the description and notes want; without, it is a group label
    and read past, as steps want.
    """
    content = [i for i, line in enumerate(lines) if line is not None]
    paragraphs = any(lines[i] is None for i in range(content[0], content[-1])) if content else False

    items: list[list[str]] = []
    from_mark = False
    mark_indent = 0
    after_blank = True
    for line in lines:
        if line is None:
            after_blank = True
            continue
        if line.styled and not line.marked and not _AMOUNT.match(line.text):
            if headings:
                items.append([_heading_text(line.text) + ":"])
            from_mark, after_blank = False, True
            continue
        if not headings and _is_group_label(line):
            from_mark, after_blank = False, True
            continue
        if line.marked:
            items.append([line.text] if line.text else [])
            from_mark, mark_indent, after_blank = True, line.indent, False
            continue
        if from_mark:
            # "Step 1" on a line of its own takes the words after it; a list
            # item takes its wrapped lines and its indented paragraphs.
            belongs = not items[-1] or not after_blank or line.indent > mark_indent
        else:
            belongs = (
                bool(items and items[-1])
                and not after_blank
                and not items[-1][-1].endswith(":")
                and (paragraphs or _carries_on(items[-1][-1], line.text))
            )
        if belongs:
            items[-1].append(line.text)
        else:
            items.append([line.text])
            from_mark = False
        after_blank = False
    joined = [" ".join(parts).strip() for parts in items]
    return [item for item in joined if item and not (not headings and item.endswith(":"))]


def _carries_on(previous: str, text: str) -> bool:
    return not re.search(r"[.!?:;)]$", previous) and text[:1].islower()


def _names_something(line: str) -> bool:
    """A line with a word in it: "2" on its own, or a lone bullet, is not an
    ingredient."""
    return re.search(r"[^\W\d_]", line) is not None


def _as_sentence(text: str) -> str:
    return text if text.endswith(":") or _SENTENCE_END.search(text) else text + "."


def _paragraph(items: list[str], *, sentences: bool) -> str:
    """Items run together as one paragraph. With `sentences` each ends as a
    sentence, as a list of notes should read; without, only those another
    follows, so a lone "Source: Aunt May" stays as it was written."""
    return " ".join(
        _as_sentence(item) if sentences or index < len(items) - 1 else item
        for index, item in enumerate(items)
    )


def _description(lead: list[str], notes: list[tuple[str | None, list[str]]]) -> str:
    """The description: the text before the first section, then every note,
    so nothing written down is lost.

    Paragraphs are separated by a blank line, as the recipe page shows them.
    The text before the first section is one, except that a heading inside
    it starts another; each note, under its heading, is one of its own.
    """
    groups: list[list[str]] = []
    for item in lead:
        heading = item.endswith(":")
        if not groups or (heading and not groups[-1][-1].endswith(":")):
            groups.append([])
        groups[-1].append(item)
    paragraphs = [_paragraph(group, sentences=False) for group in groups]
    for label, items in notes:
        if items:
            text = _paragraph(items, sentences=True)
            paragraphs.append(f"{label}: {text}" if label else text)
    return "\n\n".join(paragraphs)
