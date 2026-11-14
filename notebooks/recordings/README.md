# Recorded official WisdomTree responses

Three decoded official response texts were saved unchanged as UTF-8 on 2026-11-14 at 07:04:41–43 UTC: the US product catalog HTML, DGRW fund-page HTML and the public `/api/fund-holdings/1000521` JSON array. The source holdings report effective date 2026-11-13. The manifest records exact URLs, UTC capture times, saved byte counts and SHA-256 hashes. These are decoded-text recordings; hashes refer to the saved UTF-8 text, not compressed HTTP transfer bytes.

The real remote worker resolves the fund slug from the catalog, extracts the fund entity ID from HTML and follows the current public JSON route. The adapter checks hashes and matches exact URLs but performs no parsing, conversion or analytical calculation. Unknown requests fail. Recorded execution verifies exactly one request for each of the three responses.

The 199 source rows and their high-precision weights are real issuer data. SQL rounding in the notebook is a separate, explicitly constructed numerical experiment. Recordings have not been rounded or filtered. The provider serves current holdings only; these files do not grant historical API access. Independent responses are not an atomic snapshot.

Source: [WisdomTree](https://www.wisdomtree.com/us). Provider content remains separate from the code license; consult the provider's terms for reuse. No affiliation or endorsement is implied.
