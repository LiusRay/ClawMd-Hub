# Security Policy

ClawMd Hub is intended for personal or trusted deployments.

## Before Public Deployment

- Use a long random `ACCESS_TOKEN`.
- Serve production traffic only over HTTPS/WSS.
- Keep `.env`, logs, storage data, MongoDB dumps, and Redis dumps out of Git.
- Restrict access to MongoDB and Redis.
- Back up server storage and MongoDB regularly.

## Reporting Issues

Please open a GitHub issue with reproduction steps. Do not include secrets, private file paths, or private file content in public reports.

## Known Limitations

- Authentication is currently token-based and single-tenant.
- The current protocol is designed for trusted personal devices.
- End-to-end encryption is not implemented yet.
