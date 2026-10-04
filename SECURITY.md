# Security policy

## Supported versions

Security reports are investigated for the latest published Tofu release and the current main branch. Older development releases are not maintained separately; upgrade when a fix is published.

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub's vulnerability reporting form](https://github.com/Teyik0/Tofu/security/advisories/new), if available. Otherwise [request a private contact from a maintainer](https://github.com/Teyik0/Tofu/issues/new) without including exploit details. The repository currently requires collaborator access. Do not include tokens, downloaded content, tracker credentials, or personal data in the report.

Include the affected version, platform and architecture, a minimal reproduction, the expected and observed behavior, and the potential impact. Do not disclose the vulnerability publicly before maintainers can investigate and coordinate a fix. Maintainers will assess the report and coordinate disclosure where appropriate; an unverified report is not a confirmed vulnerability.

## Local server and credentials

Tofu listens on loopback. Direct network exposure and authentication for remote control are not implemented. The web interface controls files and downloads on the host machine. Treat access to that machine and to its local server accordingly.

Personal GitHub release tokens are stored on the host with owner-only file permissions, never included in application releases, and never returned by the API or synchronization journal. Use a token limited to Teyik0/Tofu with Contents read permission. Disconnect or revoke it when access is no longer needed. Release signing credentials belong in GitHub Actions secrets.
