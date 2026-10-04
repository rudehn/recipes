"""The marks a line of a list carries from wherever the list was kept.

Text pasted into the app arrives decorated by the app it was copied out of:
bullets from Notes and Markdown, numbering from a word processor, checkboxes
from Reminders and from the recipe cards cooking sites draw beside each
ingredient. The words are what matter, so the marks are read past here, once,
for a pasted shopping list and a pasted recipe alike.
"""

import re
from dataclasses import dataclass

# Bullets and list numbering, as Notes, Reminders, markdown and word
# processors write them. Numbering needs a space after it, so "1.5 lb" is an
# amount and not item one. So does an asterisk, as Markdown has it: without
# one it opens emphasis ("**Prep time:**", "*For the sauce*"), not a list.
_BULLET = re.compile(r"^(?:[-•·–\u2014◦▪●○‣⁃]|\*(?=\s)|\d+[.)](?=\s|$))\s*")
# "▢" is the box recipe cards draw beside each ingredient, and it is copied
# along with the line.
_OPEN_BOX = re.compile(r"^(?:\[\s?\]|☐|□|▢)\s*")
_TICKED_BOX = re.compile(r"^(?:\[[xX✓✔]\]|[☑☒✓✔✅])\s*")


@dataclass(frozen=True)
class ListLine:
    """A line with its marks read off: the words, whether it opened with any
    mark at all, and whether one of them was a tick."""

    text: str
    marked: bool
    ticked: bool


def read_list_marks(line: str) -> ListLine:
    """`line` without the bullets, numbering and boxes it opens with.

    Marks stack - "- [ ] milk", "1. ☐ eggs" - so they are taken off until
    none is left.
    """
    text = line.strip()
    marked = ticked = False
    while True:
        stripped = _BULLET.sub("", text, count=1)
        stripped = _OPEN_BOX.sub("", stripped, count=1)
        if _TICKED_BOX.match(stripped):
            ticked = True
            stripped = _TICKED_BOX.sub("", stripped, count=1)
        if stripped == text:
            break
        marked = True
        text = stripped
    return ListLine(text=text.strip(), marked=marked, ticked=ticked)
