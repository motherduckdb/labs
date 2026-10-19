from healer.checker.normalize import fingerprint, jaccard, normalize


def test_masks_variable_parts():
    a = normalize("HTTP 403 from https://wikimedia.org/api/rest_v1/metrics/x/DuckDB/daily/2026101500/2026101800: Please set a user-agent")
    b = normalize("HTTP 403 from https://wikimedia.org/api/rest_v1/metrics/x/SQL/daily/2026101600/2026101900: Please set a user-agent")
    assert a == b
    assert "HTTP 403" in a and "wikimedia.org" in a


def test_status_codes_survive():
    assert normalize("HTTP 429 from https://h.org/a") != normalize("HTTP 403 from https://h.org/a")


def test_uuid_ts_numbers():
    s = normalize("run 01a1559c-b063-75e2-b5a5-a7e1ae173ec4 at 2026-10-19T12:21:34Z failed after 37 rows in /tmp/heal_src/x.py")
    assert "<uuid>" in s and "<ts>" in s and "<n>" in s and "<path>" in s


def test_fingerprint_stable_and_scoped():
    f1 = fingerprint("p1", "HttpError", "m", ["a:f", "b:g", "c:h"])
    assert f1 == fingerprint("p1", "HttpError", "m", ["a:f", "b:g", "c:h", "d:i"])   # only the top 3 frames count
    assert f1 != fingerprint("p2", "HttpError", "m", ["a:f", "b:g", "c:h"])


def test_jaccard():
    assert jaccard("HTTP 503 from host", "HTTP 503 from host") == 1.0
    assert jaccard("a b c", "x y z") == 0.0
