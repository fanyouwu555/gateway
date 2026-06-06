# Frontend API Key Authentication Design

## Overview

Add API Key authentication to the admin frontend: login page, route guard, and 401 handling. Replaces the current hardcoded fallback key with a proper auth flow.

## Motivation

- Frontend hardcodes `admin-dashboard-key-456` which doesn't match `.env`'s `test-admin-key`
- No way for users to input/change their API key
- No route protection — all pages accessible without auth
- Logout button in user menu does nothing

## Architecture

```
App.tsx
  ├── /login  →  LoginPage (no auth required)
  └── AuthGuard
       └── MainLayout  →  protected pages (/dashboard, /providers, ...)
```

- **AuthContext** (React Context): manages `apiKey` state, exposes `login()` / `logout()`
- **AuthGuard**: reads context, redirects to `/login` if unauthenticated
- **LoginPage**: centered card form, verifies key via raw `fetch()` to `/health`
- **Axios 401 interceptor**: catches 401 responses → triggers `logout()` → redirects to `/login`

## Files

### New files (3)

| File | Purpose |
|------|---------|
| `components/Auth/AuthContext.tsx` | React Context + Provider |
| `components/Auth/AuthGuard.tsx` | Route guard wrapper |
| `pages/Login/index.tsx` | Login page with API key input |

### Modified files (4)

| File | Change |
|------|--------|
| `services/api.ts` | Remove hardcoded fallback key; add 401 response interceptor |
| `services/websocket.ts` | Read key from localStorage via helper (no hardcoded fallback) |
| `components/Layout/index.tsx` | Wire logout button to AuthContext.logout() |
| `App.tsx` | Add `/login` route; wrap pages in AuthGuard |

## Data Flow

### Login
```
User inputs key → LoginPage.fetch('/v1/ws', { headers: { 'x-api-key': key } })
  → 200: AuthContext.login(key) → localStorage.setItem('api_token', key) → navigate('/dashboard')
  → 401/error: show message.error(), keep input
```

### API Requests
```
Axios interceptor → localStorage.getItem('api_token') → Authorization: Bearer <key>
  → 401 response → AuthContext.logout() → navigate('/login')
```

### Dev Mode
```
VITE_API_KEY env var set → AuthGuard reads it on init → skip login page
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Invalid key | Show error on login page, don't clear input |
| Server unreachable | Show "无法连接到服务器", keep input |
| 401 mid-session (key revoked) | Axios 401 interceptor → logout → redirect /login |
| Page refresh | Read from localStorage on init |
| Dev mode (VITE_API_KEY) | Auto-authenticate, skip login |
| Login verification | Uses raw fetch() (not Axios) to avoid 401 interceptor loop |

## Testing

| Test | Type |
|------|------|
| Login renders, submits, handles 200/401 | Vitest component test |
| AuthGuard redirects when no key | Vitest unit test |
| AuthContext login()/logout() state transitions | Vitest unit test |
| Axios interceptor reads key and handles 401 | Vitest unit test |

## Rejected Alternatives

- **Full JWT/session login**: Overkill. API Key auth aligns with backend's existing scheme.
- **Just fix the hardcoded key**: Too minimal — no route protection, no user control.
- **Redirect param (?redirect=)**: Unnecessary complexity. Login always navigates to /dashboard.