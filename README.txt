NORTHLINE Utilitys Bot 3.0

Includes:
- Persistent ticket system with AI support
- Moderation: warn, warnings, remove-warning, timeout, kick, ban, unban
- User history and internal staff notes
- Configured staff-role management with hierarchy checks
- Staff/audit logging
- Local persistent JSON store in data/store.json

Setup:
1. Copy .env.example to .env.
2. Fill Discord/OpenAI credentials and channel/role IDs. Never commit .env.
3. npm install
4. npm start

Railway:
- Deploy the GitHub repository.
- Add the same environment variables in Railway Variables.
- For persistent local data, mount a Railway Volume at /app/data, or migrate the store to PostgreSQL in the next build.
