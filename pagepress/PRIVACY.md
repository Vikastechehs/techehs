# PagePress Privacy Notice

PagePress version 0.3 captures and converts documents locally in your browser. It does not operate a document-upload server or transmit document captures to its developer.

When you invoke PagePress on a website document viewer, it reads the displayed page count and controls, changes the viewer page/zoom as needed, and copies rendered document pixels and supported visible page layers. It saves captured images and capture settings, including source title and URL, in local extension storage so an interrupted capture can be retried. It exports those images as a PDF, individual JPEGs, or a ZIP of JPEGs through Chrome's Downloads API. All conversion and ZIP assembly happen locally.

PagePress contains no advertising, analytics, tracking service, third-party AI service, PagePress account system, or cloud document synchronization. Its PDF and page-layer libraries are distributed inside the extension. The source website may make its own normal requests while loading document pages; those remain subject to that website's policies.

Optional Pro purchases open Lemon Squeezy's hosted checkout in a separate browser tab. Payment card details are handled by the provider and are not read or stored by PagePress. The provider processes purchase, billing and customer information under its own [privacy policy](https://www.lemonsqueezy.com/privacy).

When you activate Pro, PagePress asks for browser permission to contact `https://api.lemonsqueezy.com`. It verifies your license key and checkout email, creates a browser activation, and stores the key, email, activation instance ID and activation metadata in a separate local IndexedDB database belonging to the extension's origin. Document-site scripts cannot access that database. This storage is not an encrypted credential vault. The key, instance ID, and generic browser activation label are sent to the provider as needed for activation, verification and deactivation. The checkout email is compared locally with the provider's license response. The provider also receives ordinary request metadata such as your IP address. Document pixels, source-document URLs and source-document titles are never included in these license requests.

Pro is verified when the panel opens and before captures over five pages. If the provider cannot confirm the license, the extension offers Free while keeping the license available for retry. Manage billing opens the provider's customer portal. Deactivate here releases the current browser's activation and removes locally stored license credentials after the provider confirms deactivation; it does not cancel a subscription. Cancel subscriptions through Manage billing. Uninstalling removes the local license record but does not automatically release a remote activation or cancel billing.

Use Clear capture in the panel to remove locally stored page images and job settings; it retains the separate license record. Previously downloaded files are not deleted by that action. Clearing extension data or uninstalling also removes retained local capture data and local license credentials. Chrome can retain normal download history and downloaded files independently of PagePress. The payment provider retains its purchase and billing records independently; use its privacy/support channels for related requests.

Document images and URLs can contain personal or confidential information. PagePress does not redact source content. You control where generated files are saved and whether they are shared.

This notice describes the local prototype. A published Chrome Web Store release will need a maintained public notice and developer contact information.
