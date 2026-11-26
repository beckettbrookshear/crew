"""CREW built-in browser: the server half of the Browse tab.

The CREW server fetches the page for you and hands it to the Browse tab,
because most sites refuse to be shown inside another page directly. Only the
page itself goes through CREW; its pictures, styles and scripts load straight
from the site.

Safety rules:
  * Only public internet addresses. Anything on your own network (routers,
    printers, this CREW server, other computers) is refused, and that is
    checked on the actual connection, so redirects and DNS tricks can't
    get around it.
  * Fetched pages run sandboxed: they can't see CREW, its login token,
    or any other page's data, and they can't open pop-ups.
  * No cookies or logins are passed along, so signing in to sites doesn't
    work here. That's on purpose.
  * Downloads (programs, zip files...) are not handed out.
"""
import html
import http.client
import ipaddress
import json
import re
import secrets
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_PAGE = 8_000_000          # bytes per page
TIMEOUT = 15                  # seconds per request
RATE = (60, 120)              # at most 120 pages per minute per computer
USER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 "
              "Firefox/128.0 CREW/1.0")
VIEWABLE = ("text/", "image/", "application/pdf", "application/json",
            "application/xhtml+xml", "audio/", "video/")
TYPES = {"browse_lead", "browse_nav", "share_page"}

# Sent with every page CREW shows, so a page can never act as CREW itself.
SAFE_HEADERS = {
    "Content-Security-Policy": "sandbox allow-scripts allow-forms",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


class Blocked(Exception):
    """A request CREW refuses, with a message for the person browsing."""


# ---- connections that refuse private addresses ------------------------
def _check_peer(sock):
    ip = sock.getpeername()[0].split("%")[0]
    addr = ipaddress.ip_address(ip)
    if getattr(addr, "ipv4_mapped", None):
        addr = addr.ipv4_mapped
    if not addr.is_global:
        sock.close()
        raise Blocked("CREW's browser only opens public websites. It can't "
                      "open addresses on your own network, like routers, "
                      "printers or this CREW server.")


class _SafeHTTP(http.client.HTTPConnection):
    def connect(self):
        super().connect()
        _check_peer(self.sock)


class _SafeHTTPS(http.client.HTTPSConnection):
    def connect(self):
        super().connect()
        _check_peer(self.sock)


class _HTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_SafeHTTP, req)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_SafeHTTPS, req, context=self._context)


class _Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 8

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme not in ("http", "https"):
            raise Blocked("That page tried to send you somewhere that isn't "
                          "a website.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# Built by hand (not build_opener) so there are no file://, ftp:// or
# system-proxy handlers: only the safe ones above.
_opener = urllib.request.OpenerDirector()
for _h in (_HTTPHandler(), _HTTPSHandler(context=ssl.create_default_context()),
           _Redirects(), urllib.request.HTTPErrorProcessor(),
           urllib.request.HTTPDefaultErrorHandler()):
    _opener.add_handler(_h)


def clean_url(url):
    """Returns the url if it's an http(s) web address CREW may open, else None."""
    url = str(url or "").strip()
    if len(url) > 2000 or any(c in url for c in "\r\n\t "):
        return None
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return None
    return url


def fetch(url, accept_language=""):
    """Returns (final url, status, content type, body bytes)."""
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": accept_language[:100] or "en",
        "Accept-Encoding": "identity",
    })
    try:
        resp = _opener.open(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as e:       # still show the site's error page
        resp = e
    with resp:
        final = resp.geturl()
        status = getattr(resp, "status", None) or resp.code
        ctype = resp.headers.get("Content-Type", "application/octet-stream")
        body = resp.read(MAX_PAGE + 1)
    if len(body) > MAX_PAGE:
        raise Blocked("That page is too big for CREW's browser.")
    return final, status, ctype, body


# ---- making fetched pages work inside the Browse tab -------------------
_HEAD = re.compile(rb"<head\b[^>]*>", re.I)
_BASE = re.compile(rb"<base\b", re.I)
_META = re.compile(rb"<meta\b[^>]*http-equiv\s*=\s*[\"']?\s*"
                   rb"(?:content-security-policy|refresh|x-frame-options)"
                   rb"[^>]*>", re.I)

# Runs inside each fetched page: sends link clicks and searches back to the
# Browse tab (instead of leaving it), and tells it the page's title.
_SHIM = b"""(function(){var U=__URL__;
function nav(u){try{parent.postMessage({crew:"nav",url:String(u)},"*")}catch(e){}}
document.addEventListener("click",function(e){
 var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;
 var h=a.href;if(!/^https?:/i.test(h))return;e.preventDefault();
 if(h.split("#")[0]===U.split("#")[0]&&h.indexOf("#")>=0){
  var id=decodeURIComponent(h.slice(h.indexOf("#")+1));
  var t=document.getElementById(id)||document.getElementsByName(id)[0];
  if(t)t.scrollIntoView();else if(!id)scrollTo(0,0);return}
 nav(h)},true);
document.addEventListener("submit",function(e){
 var f=e.target;e.preventDefault();
 if((f.getAttribute("method")||"get").toLowerCase()!=="get"){
  parent.postMessage({crew:"post"},"*");return}
 var u=new URL(f.getAttribute("action")||U,document.baseURI),q=new URLSearchParams();
 new FormData(f).forEach(function(v,k){if(typeof v==="string")q.append(k,v)});
 if(e.submitter&&e.submitter.name)q.append(e.submitter.name,e.submitter.value||"");
 u.search=q.toString();nav(u.href)},true);
window.open=function(u){if(u)nav(new URL(u,document.baseURI).href);return null};
function ready(){parent.postMessage({crew:"loaded",url:U,title:document.title},"*")}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready);else ready();
})();"""


def rewrite(page, url):
    page = _META.sub(b"", page)
    inject = b""
    if not _BASE.search(page[:50_000]):        # make relative links point at the site
        inject += b'<base href="' + html.escape(url).encode() + b'">'
    js_url = json.dumps(url).replace("</", "<\\/").encode()
    inject += b"<script>" + _SHIM.replace(b"__URL__", js_url) + b"</script>"
    m = _HEAD.search(page)
    if m:
        return page[:m.end()] + inject + page[m.end():]
    return inject + page


def message_page(title, text, url=""):
    link = (f'<p><a href="{html.escape(url)}">{html.escape(url)}</a></p>'
            if url else "")
    return (f"""<!doctype html><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>:root{{color-scheme:light dark}}body{{font:15px/1.5 system-ui,sans-serif;
max-width:560px;margin:12vh auto;padding:0 16px}}h1{{font-size:20px}}
p{{opacity:.85}}a{{word-break:break-all}}</style>
<h1>{html.escape(title)}</h1><p>{html.escape(text)}</p>{link}
<script>parent.postMessage({{crew:"loaded",url:{json.dumps(url)},title:{json.dumps(title)},error:true}},"*")</script>"""
            .replace("</script>\n", "</script>").encode())


def page(url, accept_language="", allowed=True, limited=False):
    """Everything the /api/browse route needs. Returns (status, type, body)."""
    if not allowed:
        return 401, "text/html; charset=utf-8", message_page(
            "Not signed in", "Rejoin the group to use the browser.")
    if limited:
        return 429, "text/html; charset=utf-8", message_page(
            "Slow down", "Too many pages in a minute. Wait a moment and try again.")
    url = clean_url(url)
    if not url:
        return 400, "text/html; charset=utf-8", message_page(
            "Can't open that", "Only http:// and https:// web addresses work here.")
    try:
        final, status, ctype, body = fetch(url, accept_language)
    except Blocked as e:
        return 403, "text/html; charset=utf-8", message_page(
            "Blocked", str(e), url)
    except (urllib.error.URLError, OSError, http.client.HTTPException,
            ValueError) as e:
        reason = getattr(e, "reason", e)
        return 502, "text/html; charset=utf-8", message_page(
            "Couldn't open this page", f"The site didn't answer ({reason}).", url)
    kind = ctype.split(";")[0].strip().lower()
    if kind in ("text/html", "application/xhtml+xml"):
        return status, ctype, rewrite(body, final)
    if not kind.startswith(VIEWABLE):
        return 200, "text/html; charset=utf-8", message_page(
            "That's a file download",
            f"This link is a file ({kind}), not a web page. CREW's browser "
            "doesn't download files; open it in your normal browser if you "
            "trust it.", final)
    return status, ctype, body


# ---- browsing together --------------------------------------------------
def key_for(peer):
    """A key that only works for browsing, so the main login token never
    has to appear in a page address."""
    if not getattr(peer, "browse_key", None):
        peer.browse_key = secrets.token_urlsafe(18)
    return peer.browse_key


def allowed(peer, key):
    return peer is not None and secrets.compare_digest(key_for(peer), str(key))


def peer_info(peer):
    """What others see about someone who is sharing their browsing."""
    if getattr(peer, "browse_lead", False):
        return getattr(peer, "browse_page", None) or {"url": "", "title": ""}
    return None


def _page_info(m):
    url = clean_url(m.get("url"))
    if not url:
        return None
    title = re.sub(r"[\x00-\x1f\x7f]", "", str(m.get("title") or ""))[:200]
    return {"url": url, "title": title.strip()}


def dispatch(room, peer, m, scan_text):
    """Handle browse_lead / browse_nav / share_page. Returns an error or None."""
    kind = m.get("type")

    if kind == "browse_lead":
        on = bool(m.get("on"))
        if on == getattr(peer, "browse_lead", False):
            return None
        peer.browse_lead = on
        peer.browse_page = _page_info(m) if on else None
        room.system(f"{peer.name} is sharing their browsing. You can follow "
                    f"along in the Browse tab." if on else
                    f"{peer.name} stopped sharing their browsing.")
        room.announce_peers()
        return None

    if kind == "browse_nav":
        if not getattr(peer, "browse_lead", False):
            return None
        info = _page_info(m)
        if not info:
            return "That isn't a web address."
        peer.browse_page = info
        for level, why, ex in scan_text(info["url"]):
            room.alert("Browse", level, why.replace("posted", "led followers "
                                                    "to"), peer, ex)
        room.broadcast({"type": "browse_nav", "from": peer.id,
                        "fromName": peer.name, **info}, exclude=peer.id)
        room.announce_peers()
        return None

    if kind == "share_page":
        info = _page_info(m)
        if not info:
            return "That isn't a web address."
        for level, why, ex in scan_text(info["url"]):
            room.alert("Browse", level, why.replace("posted", "shared"),
                       peer, ex)
        room.broadcast({"type": "chat", "from": peer.id, "fromName": peer.name,
                        "text": "shared a page: " + (info["title"] or
                                                     info["url"]),
                        "link": info["url"], "ts": time.time() * 1000})
        return None

    return f"Unknown message type: {kind!r}"
