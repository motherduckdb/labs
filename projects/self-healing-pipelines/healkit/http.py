"""HTTP adapter for pipelines: real requests, structured errors, optional retries, chaos knobs.

Retries are opt-in on purpose. A pipeline that has never needed them shouldn't silently paper over
upstream trouble; when a fix adds `retries=` / `honor_retry_after=` it is a reviewed code change.
"""
import json
import random
import time
from urllib.parse import urlsplit

import requests

from . import chaos
from .redact import redact

HTTPBINGO = "https://httpbingo.org"


class HttpError(Exception):
    def __init__(self, status, url, body, headers):
        self.status, self.url, self.body = status, redact(url), redact(body)[:1500]
        keep = ("retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "content-type")
        self.headers = {k: v for k, v in headers.items() if k.lower() in keep}
        super().__init__(f"HTTP {status} from {self.url}: {self.body[:400]}")

    @property
    def host(self):
        return urlsplit(self.url).hostname


class Http:
    def __init__(self, pipeline: str, user_agent: str | None = None, timeout: float = 30.0):
        self.pipeline, self.timeout = pipeline, timeout
        self.session = requests.Session()
        if user_agent is not None:
            self.session.headers["User-Agent"] = user_agent
        else:
            # Behave like a bare HTTP library would (Python-urllib style UA) so policy checks see it.
            self.session.headers["User-Agent"] = "Python-urllib/3.12"
        self._attempts: dict[str, int] = {}
        self.requests_made = 0

    def _apply_chaos(self, url: str, headers: dict) -> tuple[str, dict]:
        host = urlsplit(url).hostname or ""
        w = chaos.world(self.pipeline)
        if f"headers.{host}" in w:
            headers = {**headers, **json.loads(w[f"headers.{host}"])}
        if w.get(f"auth.{host}") == "bad":
            headers = {**headers, "Authorization": "Bearer ghp_invalidinvalidinvalidinvalid0000"}
        n = self._attempts[url] = self._attempts.get(url, 0) + 1
        if f"ratelimit.{host}" in w and n <= int(w[f"ratelimit.{host}"]):
            return f"{HTTPBINGO}/status/429", headers
        if f"flaky.{host}" in w and random.random() < float(w[f"flaky.{host}"]):
            return f"{HTTPBINGO}/status/503", headers
        if f"route.{host}" in w:
            return w[f"route.{host}"], headers
        return url, headers

    def get(self, url: str, params: dict | None = None, headers: dict | None = None, *, retries: int = 0,
            honor_retry_after: bool = False, backoff_s: float = 1.0, max_sleep_s: float = 60.0,
            min_interval_s: float = 0.0) -> requests.Response:
        """GET with optional retries on 429/5xx/connection errors. Raises HttpError on a final >= 400."""
        attempt = 0
        while True:
            real_url, hdrs = self._apply_chaos(url if not params else requests.Request("GET", url, params=params).prepare().url,
                                               headers or {})
            if min_interval_s:
                time.sleep(min_interval_s)
            self.requests_made += 1
            try:
                r = self.session.get(real_url, headers=hdrs, timeout=self.timeout)
            except requests.RequestException as e:
                if attempt < retries:
                    attempt += 1
                    time.sleep(min(max_sleep_s, backoff_s * 2 ** (attempt - 1)))
                    continue
                raise
            if r.status_code < 400:
                return r
            retryable = r.status_code == 429 or r.status_code >= 500
            if retryable and attempt < retries:
                attempt += 1
                wait = backoff_s * 2 ** (attempt - 1)
                if honor_retry_after and r.headers.get("Retry-After", "").strip().isdigit():
                    wait = float(r.headers["Retry-After"])
                time.sleep(min(max_sleep_s, wait))
                continue
            # Report the URL the pipeline asked for; the chaos route is an implementation detail of the world.
            raise HttpError(r.status_code, url, r.text, r.headers)

    def get_json(self, url: str, **kw):
        return self.get(url, **kw).json()
