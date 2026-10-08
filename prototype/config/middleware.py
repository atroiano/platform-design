"""Response headers for a page that handles account data."""

# Scripts only from this origin. MUI injects styles at run time, so inline
# styles stay allowed. No page may frame this one.
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
)


class ResponseHeaders:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        path = request.path
        if path.startswith("/api/"):
            # Account data must not sit in a browser or proxy cache.
            response.headers.setdefault("Cache-Control", "no-store")
        # The documentation page is third-party markup with an inline script.
        if not path.startswith("/api/v1/docs"):
            response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        response.headers.setdefault("X-Frame-Options", "DENY")
        return response
