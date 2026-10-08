import re

from django.conf import settings
from django.http import HttpResponse, HttpResponseNotAllowed, HttpResponseNotFound
from django.urls import path, re_path

from hivear.api import api

_FILE = re.compile(r"\.[A-Za-z0-9]{1,8}$")


def frontend(request):
    """The single-page application's entry document, for a page address that
    is not the API. Anything that is not a browser asking for a page is told
    plainly that nothing is here, so a mistyped API path or a missing file
    never comes back as a 200 full of HTML."""
    if request.method not in ("GET", "HEAD"):
        return HttpResponseNotAllowed(["GET", "HEAD"])
    index = settings.FRONTEND_DIST / "index.html"
    if _FILE.search(request.path) or not index.exists():
        return HttpResponseNotFound("Nothing is served at this address. The API is under /api/v1/.")
    response = HttpResponse(index.read_bytes(), content_type="text/html; charset=utf-8")
    response["Cache-Control"] = "no-cache"
    return response


urlpatterns = [
    path("api/v1/", api.urls),
    # Not the API, in any letter case, with or without a trailing slash.
    re_path(r"^(?!(?i:api|static|assets)(?:/|$)).*$", frontend),
]
