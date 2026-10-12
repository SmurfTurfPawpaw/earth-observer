# Conditional annual gas exposure

`src/core/gas-scenario.js` provides one deterministic counterfactual over a retained
Eurostat dossier. It introduces no data collection, model, database write, new
source or UI. Source quantities and revisions remain unchanged.

## Integration contract

```js
import { createGasExposureScenario } from './gas-scenario.js';

const scenario = await createGasExposureScenario(storedGasEnvelope, {
  year: '2024',
  originCode: 'NO',
  reductionPercent: 25,
  replacementPercent: 40,
});
```

`storedGasEnvelope` is the available response of the existing stored-only
`/api/dossiers/belgium-natural-gas-origins` endpoint: schema 1, the fixed dataset
plugin, exact receipt and `dataset-dossier` artifact. The method verifies the
canonical artifact SHA against that receipt and binds its input/raw hashes,
source identity, dates and version. This is an integrity check, not a provider
digital signature or a way to authenticate an arbitrary caller-created envelope.
Callers must use the platform's admitted stored response.

The result is serializable schema 1 with `kind: 'conditional-gas-exposure'`,
`methodId: 'gas-origin-reduction-v1'` and a content-hashed `scenario:` ID. Its
`baseline` retains the reporting country, selected source country/territory,
reference-year period, resource, gross-calorific-value TJ unit, origin quantity,
reported total and supported share. `provenance` retains the exact receipt,
input revision/digest, raw/artifact hashes, source dates/version, official links
and origin/TOTAL cell locators. Operational check clocks do not enter the result.
This local method creates no analysis publication or claimed forecast date.

## Arithmetic and assumptions

Replacement means a percentage of the **lost origin quantity**, not a percentage
of all annual imports. Both percentages accept finite numbers from 0 to 100.

```text
lostOriginVolume = originVolume × reductionPercent / 100
replacementVolume = lostOriginVolume × replacementPercent / 100
residualGapVolume = lostOriginVolume − replacementVolume
residualGapPercentOfReportedTotal = 100 × residualGapVolume / reportedTotal
```

The retained source fixture reports Norway at 245,893.2 TJ_GCV and Belgium's
2024 TOTAL at 740,439.9 TJ_GCV. A 25% reduction with 40% replacement yields
61,473.3 lost, 24,589.32 replaced and 36,883.98 residual TJ_GCV. Display rounding
belongs to the UI; calculation values remain unrounded. Source: Eurostat,
[nrg_ti_gas](https://ec.europa.eu/eurostat/databrowser/view/nrg_ti_gas/default/table).

The chosen origin is reduced and the other reported origins are held fixed.
Replacement is stated hypothetical supply, not verified available capacity or an
identified replacement country. A zero reduction or 100% replacement gives zero
residual gap. The result is a reference-year counterfactual: it is not a present
supply estimate, consumption dependency, shipment route, disruption likelihood,
geopolitical effect or price prediction. No probability or future observation is
created. UI integration must preserve the hypothetical meaning, year and units.

## Admission and limits

The method requires a completed calendar year and a positive, unflagged,
reconciled reported TOTAL. Missing/flagged/negative data, inconsistent counts,
units, source scope, locators, proportions or declared reconciliation tolerance
fail closed. It checks the source's complete-breakdown declaration and numerical
consistency; the public artifact does not contain every raw source cell, so this
does not independently re-audit the complete dataset from its original bytes.
Raw/canonical source admission remains the reviewed plugin's responsibility.

Only one explicit reported country/territory is selectable. Statistical residual
regions and unspecified origins cannot be selected. Duplicate codes, duplicate
cell references and aliases such as UK/GB or EL/GR cannot be counted twice.
Known overlapping aggregates are rejected. This method does not offer arbitrary
multi-origin sums or prove the geographic membership of every statistical region.

The dossier displays at most 20 positive origins. A genuinely complete source may
omit smaller rows from that display; visible origins remain usable and omission
counts are preserved. Missing, zero or omitted selections cannot be inferred from
the displayed artifact. Supporting zero-valued or additional selected origins
would require a separately reviewed cited-cell interface, not synthetic rows.

Invalid assumptions throw a `TypeError` with
`code: 'gas_scenario_invalid_assumptions'`. Unavailable or incompatible evidence
throws `code: 'gas_scenario_unavailable'`; no scenario is returned. The calculation
uses only WebCrypto and existing pure codecs. It consumes the existing 64 KiB
artifact limit, at most eight annual periods and twenty visible origin rows.

Focused offline verification:

```text
node --test src/core/gas-scenario.test.mjs
```

The tests reuse the adapter's real retained Eurostat fixture and cover source
immutability, formula results, zero/full/tiny percentages, exact receipt binding,
unsupported units and years, numerical/data gaps, alias overlap, a complete source
with a display omission, repeatable identity and independence from check clocks.
