"""Read-only probes an app adds to the smoke check (SHARED-0010)."""

_probes = {}


def probe(name):
    def register(function):
        _probes[name] = function
        return function

    return register


def probes() -> dict:
    return dict(_probes)
