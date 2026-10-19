"""Prompt-injection screen for untrusted upstream text fields (Jev `noul`, p >= 0.5 -> quarantine).

Screening routes rows; it is not the defence. The defences are that agents treat upstream text as data,
the deterministic guards, and the approver. A Jev failure (NULL) flags the row for the fixer and
approver instead of silently passing it.
"""
from . import db, jev


def screen(con, texts: list[str]) -> list[dict]:
    """Returns per text {p, injected, flagged}; injected -> quarantine, flagged -> unknown, keep but mark.
    Runs on the shared connection so a pipeline's open load transaction stays single-database."""
    out = []
    answers = jev.jev_batch(db.shared(), "prompt_injection", [t or "" for t in texts])
    thr = jev.TASKS["prompt_injection"]["accept"]["p_gte"]
    for t, p in zip(texts, answers):
        if not t:
            out.append({"p": 0.0, "injected": False, "flagged": False})
            continue
        out.append({"p": p, "injected": p is not None and p >= thr, "flagged": p is None})
        jev.log(con, "prompt_injection", (t or "")[:80], "injected" if (p or 0) >= thr else "clean", p, p, False,
                "flag_for_fixer" if p is None else None)
    return out
