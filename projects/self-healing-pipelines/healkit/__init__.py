"""healkit: shared library for self-healing pipelines (HTTP adapter, data tests, HEAL_EVENT logger,
guarded execute, redaction, Jev helpers). Lives outside healer/ but is treated as healer code: changes
are always L3, because the guards are implemented here."""
