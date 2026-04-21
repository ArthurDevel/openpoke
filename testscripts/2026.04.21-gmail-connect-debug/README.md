# Gmail Connect Debug

Goal: reproduce and debug why the app still says Gmail is not connected even though `COMPOSIO_API_KEY` and `COMPOSIO_GMAIL_AUTH_CONFIG_ID` are set.

Approach:
- call the running backend endpoints directly
- inspect the responses from `/api/v1/gmail/connect` and `/api/v1/gmail/status`
- compare that to how the agent checks for an active Gmail account

Files:
- `check_composio_auth.py`: standalone check for Composio auth and Gmail connected accounts
- `output/`: captured responses and notes
- `input/`: reserved for any local request payloads if needed

Result:
- Root cause: the `.env` entry for `COMPOSIO_API_KEY` had the variable name duplicated inside the value, so the backend loaded `COMPOSIO_API_KEY=ak_...` instead of `ak_...`.
- After correcting that entry, the backend can authenticate to Composio successfully.
- Current remaining state: Composio reports `0` Gmail connected accounts, so the user still needs to complete the Gmail OAuth flow in Settings.
- This was not an auth-config-id vs account-id mismatch. The original failure was malformed API key configuration.
