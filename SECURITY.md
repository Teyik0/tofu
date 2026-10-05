# Security policy

## Supported versions

Security reports are investigated for the latest published Tofu release and the current main branch. Older development releases are not maintained separately; upgrade when a fix is published.

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub's vulnerability reporting form](https://github.com/Teyik0/Tofu/security/advisories/new), if available. Otherwise [request a private contact from a maintainer](https://github.com/Teyik0/Tofu/issues/new) without including exploit details. The repository is public and accepts reports without collaborator access. Do not include tokens, downloaded content, tracker credentials, or personal data in the report.

Include the affected version, platform and architecture, a minimal reproduction, the expected and observed behavior, and the potential impact. Do not disclose the vulnerability publicly before maintainers can investigate and coordinate a fix. Maintainers will assess the report and coordinate disclosure where appropriate; an unverified report is not a confirmed vulnerability.

## Local server and credentials

Tofu listens on loopback. Direct network exposure and authentication for remote control are not implemented. The web interface controls files and downloads on the host machine. Treat access to that machine and to its local server accordingly.

Tofu stores no GitHub credential: update checks and installer downloads use the GitHub REST API anonymously. Local state files keep owner-only file permissions (0600). Release signing credentials belong in GitHub Actions secrets.
