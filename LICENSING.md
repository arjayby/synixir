# Synixir licensing

Copyright 2026 Arjay Bayona.

Synixir uses separate licenses for its backend and its application-facing code.
These are licenses for different components, not a choice of either license for
all of the repository.

| Scope | License | License text |
| --- | --- | --- |
| Backend and repository files outside the exceptions below, including `lib/`, `config/`, `priv/`, backend tests, and deployment/operations tooling | AGPL-3.0-or-later | [LICENSE](LICENSE) |
| JavaScript SDK and all files in `packages/client/` | Apache-2.0 | [SDK LICENSE](packages/client/LICENSE) |
| Playground examples and all files in `examples/collaboration/` | Apache-2.0 | [Playground LICENSE](examples/collaboration/LICENSE) |

Third-party code, dependencies, assets, and existing copyright notices retain
their respective licenses. This policy licenses the original Synixir code; it
does not replace third-party terms. The standard license texts themselves retain
their own notices.

## Backend grant

Synixir's backend is free software: you can redistribute it and/or modify it
under the terms of the GNU Affero General Public License as published by the
Free Software Foundation, either version 3 of the License, or (at your option)
any later version.

Synixir is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE. See the GNU Affero General Public License for details.

## Hosting and self-hosting

You can self-host Synixir under the AGPL without paying the author a license fee,
and commercial use is permitted. If you modify the covered backend and let users
interact with it over a network, section 13 requires you to prominently offer
those users the Corresponding Source of that modified version under the AGPL.
Distribution of backend source or binaries also carries the license's source
and notice obligations. The full license governs the exact requirements.

The Apache-licensed SDK and playground can be reused under Apache-2.0, including
in proprietary applications. Keep their license and notice files when distributing
them and preserve applicable third-party notices. These directory exceptions do
not relicense copied or incorporated backend code under Apache-2.0.

The author can charge for operating a managed Synixir service, support, or other
services. This repository's license does not establish hosted-service pricing,
customer terms, or a mandatory self-hosting fee. Any alternative commercial
license would require a separate agreement from the relevant rights holders;
no additional proprietary license is granted here.

## Source and contributions

The upstream source and project contact are at
[github.com/arjayby/synixir](https://github.com/arjayby/synixir).
When distributing a release or operating a modified backend, provide the source
for the actual version offered, including the scripts needed to build and run
it. A link to an unrelated or newer upstream version does not cover your changes.

Unless separately agreed, contributions are submitted under the license that
applies to their directory. Contributors retain their copyrights. No copyright
assignment or contributor agreement is introduced by this policy.
