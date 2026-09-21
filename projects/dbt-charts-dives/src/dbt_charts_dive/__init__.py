"""dbt Charts boards -> live MotherDuck Dives.

Importing this package applies the MotherDuck compatibility patches for dbt-charts
(``md_compat``). The pieces:

* ``config``       — which boards become Dives (the ``dive:`` block) and how to compile one
* ``builder``      — board YAML -> Dive source, using dbt-charts' own compiler, with
  ``sql`` (the statement a Dive sends), ``presentation`` (what a card looks like),
  ``specs`` (the Vega-Lite it renders) and ``variables`` (what a control does)
* ``bundle``       — the Vega runtime the Dive embeds, matched to dbt-charts
* ``publisher``    — upsert a Dive by name with MotherDuck's MD_* SQL functions
* ``flight``       — the entry point that runs all of the above inside a MotherDuck Flight

A dbt v2 run never imports any of this: the dbt package's ``save_charts_as_dives`` macro
stages this source into MotherDuck and a Flight runs it there.
"""

from dbt_charts_dive import md_compat as _md_compat

_md_compat.apply()
