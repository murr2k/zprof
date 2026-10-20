# N6 register workbook

`svd_workbook.py` builds zprof's annotated STM32N657 register workbook from
ST's SVD and the Zephyr devicetree at the pin. Usage is in the script's
docstring; the workbook's About tab defines the columns.

## Inputs and where they come from

Neither input is in this repository. The SVD comes from ST, so an update from
ST reaches the workbook; the Zephyr tree is fixed by the pin.

| Item | Value |
|---|---|
| SVD source | https://www.st.com/resource/en/svd/stm32n6-svd.zip (found through ST's site search). Pass the zip as downloaded; the script reads `STM32N657.svd` from it without extracting |
| Baseline package | `STM32N6_svd_v1r0`: release notes V1.0, first release; files dated 2024-10-10; downloaded 2026-10-19 |
| Zip SHA-256 | `420671852dd201a243873ec5e3167181b19b945726413daf41b4b0dae0abb8ad` |
| `STM32N657.svd` | SVD `<version>` 1.0; 23,710,541 bytes with CRLF line endings; SHA-256 `930f0f8aecfb4689b27a84e141439bc967096f0a4d3c5bf6cc00d07fc5b0f153`; git blob of the LF form `08fa4929eec6c1c6d3f69fab7f049c6b3e9e3997` |
| License | Apache-2.0 (the header of each SVD); ST's text in the workbook's description columns stays ST's |
| Zephyr tree | Zephyr at `a915b2f12675`, the SHA in `firmware/west.yml`: `west init -l firmware` then `west update` from the repository root, or a plain clone checked out at that SHA |

The baseline is the SVD the curated tables in the script were reviewed
against (`BASELINE` there): block descriptions, the zprof signals, read side
effects, the core registers the SVD omits, and the known defects.

## Checking for updates

Every run compares the SVD with the baseline and, unless `--offline`, with
`CMSIS/SVD/STM32N657.svd` in Arm's
[Open-CMSIS-Pack/STM32N6xx_DFP](https://github.com/Open-CMSIS-Pack/STM32N6xx_DFP),
and writes the result to the About tab. `--check` does only the comparison:
exit 0 current, 1 a different SVD exists, 2 could not tell.

- Why not ST directly: ST's site answers browsers only. Plain HTTP clients
  (curl, Python, PowerShell, with or without an identifying user agent) get a
  TLS connection and then no response, so the script would have to pose as a
  browser, which it does not do.
- Why the DFP works: Arm's Device Family Pack repackages ST's SVD with LF line
  endings; its blob is byte-identical to the baseline's LF form, and GitHub's
  API lists it, so the check downloads nothing.
- Lag: the DFP follows ST, it does not lead. Its first commit (2024-12-18)
  came about ten weeks after ST's V1.0 files were dated. Checking ST's page by
  hand now and then still catches an update sooner.

## When ST releases an update

1. Download the new zip from ST and run the generator on it. It stops if a
   zprof signal's register or field is gone; fix `SIGNALS`.
2. Re-review the curated tables against the new SVD. A known defect that ST
   fixed drops out of the report on its own.
3. Set `BASELINE` and the table above to the new package, regenerate, and
   replace the published workbook.
