# bumpkit

Picks the next semantic version from [conventional commit](https://www.conventionalcommits.org) messages.

```js
import { nextVersion } from "bumpkit";

nextVersion("1.4.2", ["fix: trim whitespace", "feat: add --json"]); // "1.5.0"
```

No dependencies.

| Commit | Release |
| --- | --- |
| `fix:`, `perf:` | patch |
| `feat:` | minor |
| `feat!:`, or a `BREAKING CHANGE:` footer | major |
| anything else | none |

```sh
npm install
npm test
```
