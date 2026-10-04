"""Where a recipe came from: what of its link is worth keeping, and when two
links are the same page.

A link to one recipe page arrives in more than one spelling. Shared from a
phone it carries tracking parameters; typed from memory it lacks "www.";
copied from an old bookmark it is http; followed from a "jump to recipe"
button it ends in an anchor. The importer would read every one of them as a
new recipe, so a draft is checked against the links already saved, and the
page can say "already in your box" instead. See routes.import_recipe.

Pure string work with no database or schema in it, so the schemas can tidy a
link as it comes in.
"""

from urllib.parse import parse_qsl, unquote_plus, urlencode, urlsplit, urlunsplit

# Query parameters that say how someone reached a page, never which page it
# is. They are dropped before a link is stored, so "View original" does not
# carry a newsletter's campaign back to the site, and ignored when two links
# are compared, so the same recipe shared twice is one recipe. Everything
# else in a query is kept and compared: a site without pretty permalinks
# names the recipe there ("?p=123"), and calling every such page the same
# would be worse than missing a duplicate. Compared without regard to case.
#
# Campaign tagging. The utm_ convention began with Google Analytics and is
# now what every newsletter, social scheduler and link shortener writes, with
# custom utm_ keys of its own, so the whole prefix goes.
_TRACKING_PREFIXES = ("utm_",)
_TRACKING_KEYS = frozenset(
    {
        # Ad click identifiers, appended by the ad network to every link it
        # serves so a later visit can be tied to the click: Meta, Google Ads
        # (gclid, and gbraid/wbraid on iOS), Google's display network,
        # Microsoft Ads, Yandex, X, TikTok, LinkedIn and Pinterest.
        "fbclid",
        "gclid",
        "gbraid",
        "wbraid",
        "dclid",
        "msclkid",
        "yclid",
        "twclid",
        "ttclid",
        "li_fat_id",
        "epik",
        # Email platforms, naming the campaign and the recipient it was sent
        # to: Mailchimp, HubSpot and Marketo.
        "mc_cid",
        "mc_eid",
        "_hsenc",
        "_hsmi",
        "mkt_tok",
        # The sharer, stamped by the share sheet of an app: Instagram.
        "igshid",
        "igsh",
        # Google Analytics carrying a visitor's identity across domains.
        "_ga",
        "_gl",
        # Referrer tags, the site or post a link was followed from: the
        # generic one, and X's.
        "ref",
        "ref_src",
    }
)


def _is_tracking(key: str) -> bool:
    key = key.lower()
    return key in _TRACKING_KEYS or key.startswith(_TRACKING_PREFIXES)


def without_tracking(url: str) -> str:
    """The link with its tracking parameters taken out and nothing else
    touched: what identifies the page stays in its own order and spelling,
    and the anchor it was shared with stays too.
    """
    parts = urlsplit(url)
    if not parts.query:
        return url
    fields = parts.query.split("&")
    kept = [f for f in fields if not _is_tracking(unquote_plus(f.partition("=")[0]))]
    if len(kept) == len(fields):
        return url
    return urlunsplit(parts._replace(query="&".join(kept)))


def bare_host(url: str) -> str:
    """The site a link points at, lowercased and without a leading "www.".

    The search allowlist names sites by this too, so a link typed with
    "WWW.BudgetBytes.com" is still Budget Bytes.
    """
    return (urlsplit(url).hostname or "").removeprefix("www.")


def source_key(url: str) -> str:
    """What two links to the same recipe page have in common.

    Kept: the host, the path and the query parameters that are not tracking,
    which together are the page. Dropped: the scheme, since a site serves the
    same page on http and https; a leading "www.", which is the same site;
    tracking parameters; the order of the rest, which no server reads; the
    fragment, which only scrolls; and a trailing slash, which WordPress adds
    and people leave off. The path keeps its case, since a server may tell
    "/Chili" from "/chili" even though no host is told apart by case.
    """
    parts = urlsplit(url)
    key = bare_host(url) + parts.path.rstrip("/")
    query = sorted(
        (name, value)
        for name, value in parse_qsl(parts.query, keep_blank_values=True)
        if not _is_tracking(name)
    )
    return f"{key}?{urlencode(query)}" if query else key
