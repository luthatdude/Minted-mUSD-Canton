# Minted.app — Main Landing Page Layout

> The top-level hero landing page for Minted. This is NOT the mUSD app — this is the parent site that links to **mUSD** and **BLE**.

---

## Overview

The main Minted landing page is a full-screen immersive experience with motion art. It introduces the Minted brand, delivers the core thesis, and funnels users into two product pages: **mUSD** (the stablecoin app) and **BLE** (Beneficiary Locked Environment).

---

## Page Structure

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  FULL-SCREEN HERO — Motion art background                        │
│  (THREE.js or equivalent — eye-catching, animated)               │
│                                                                  │
│  ┌─ NAV (minimal, top) ────────────────────────────────────────┐│
│  │  Logo: Minted                                                ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│                                                                  │
│  ┌─ HEADLINE ──────────────────────────────────────────────────┐│
│  │                                                              ││
│  │  "The Ownership Abstraction Layer                            ││
│  │   For On Chain Economies,                                    ││
│  │   Powered by mUSD"                                           ││
│  │                                                              ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─ BODY TEXT ─────────────────────────────────────────────────┐│
│  │                                                              ││
│  │  The bifurcation between utility and equity has been an      ││
│  │  insurmountable issue in Web3. Until now.                    ││
│  │                                                              ││
│  │  Our first mover, compliant, technology acts as the          ││
│  │  fundamental bridge between these 2 worlds.                  ││
│  │                                                              ││
│  │  Our "Beneficiary Locked Environment" was built as a         ││
│  │  modular primitive to not only allow token holders access     ││
│  │  to intrinsic value like equity, revenue share, and          ││
│  │  acquisition rights, but it also allows institutional        ││
│  │  grade assets access to composable decentralized finance     ││
│  │  through our stable coin mUSD on Canton Network.             ││
│  │                                                              ││
│  │  We're reshaping what ownership means in Web3.               ││
│  │                                                              ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─ TWO PRODUCT LINKS (with motion graphics) ─────────────────┐│
│  │                                                              ││
│  │  ┌──────────────────┐       ┌──────────────────────────────┐││
│  │  │                  │       │                              │││
│  │  │      mUSD        │       │  Beneficiary Locked          │││
│  │  │                  │       │  Environment                 │││
│  │  │  → mUSD App      │       │                              │││
│  │  │                  │       │  → BLE Page                  │││
│  │  │                  │       │                              │││
│  │  └──────────────────┘       └──────────────────────────────┘││
│  │                                                              ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Section Details

### 1. Motion Art Background

- Full viewport, behind all content
- Should be VERY eye-catching with continuous motion
- THREE.js or equivalent technology
- Visually represents the concept of ownership, connectivity, or economic flow

### 2. Navigation

- Minimal — logo only
- No nav links, no buttons in the header
- This is a brand page, not an app

### 3. Headline

> **"The Ownership Abstraction Layer For On Chain Economies, Powered by mUSD"**

### 4. Body Copy

> The bifurcation between utility and equity has been an insurmountable issue in Web3. Until now.
>
> Our first mover, compliant, technology acts as the fundamental bridge between these 2 worlds.
>
> Our "Beneficiary Locked Environment" was built as a modular primitive to not only allow token holders access to intrinsic value like equity, revenue share, and acquisition rights, but it also allows institutional grade assets access to composable decentralized finance through our stable coin mUSD on Canton Network.
>
> We're reshaping what ownership means in Web3.

### 5. Two Product Links

After the body text, beautiful motion graphics lead into two distinct link choices:

| Link | Destination | Description |
|------|-------------|-------------|
| **mUSD** | mUSD app (LandingPage → Enter App) | The stablecoin protocol — mint, stake, borrow, bridge |
| **Beneficiary Locked Environment** | BLE page | The ownership infrastructure — equity, revenue share, acquisition rights |

- Each link should be a large, visually striking card or region
- Motion graphics / animation between or around the two choices
- Clear visual distinction between the two products

---

## Key Principles

1. **Immersive** — this is a brand experience, not a dashboard
2. **Motion-first** — animated visuals are the primary design element
3. **Two exits** — the only actions are clicking mUSD or BLE
4. **No app chrome** — no wallet connect, no chain toggle, no nav tabs
5. **Copy is verbatim** — the headline and body text above are final
