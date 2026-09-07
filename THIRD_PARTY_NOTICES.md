# Third-party notices

The application includes the following unmodified browser libraries. Their original notices remain in the distributed JavaScript files, and their license texts are included below.

| Component | Version | Files | License text |
| --- | --- | --- | --- |
| Marked | 18.0.11 | `src/renderer/vendor/marked.umd.js` | [Marked license](licenses/marked-LICENSE.txt) |
| DOMPurify | 3.4.15 | `src/renderer/vendor/purify.min.js` | [DOMPurify license](licenses/DOMPurify-LICENSE.txt) |

Electron and its bundled Chromium components retain their `LICENSE` and `LICENSES.chromium.html` files in the generated `App` directory. Keep these files when distributing a build. Other development dependencies and their versions are recorded in `package-lock.json`; their notices are available in their installed packages.

The project currently declares `UNLICENSED` for its own code. These third-party notices do not grant an open-source license for the project's own code or artwork.
