---
version: alpha
name: Shadow
description: Sponsor funded agent services on Arc, with spending limits and repayment tracking.
colors:
  bg: "#07111f"
  bg-2: "#0b1728"
  surface: "#0f1d31"
  surface-2: "#14243a"
  surface-3: "#1b2c47"
  border: "rgba(184, 211, 255, 0.1)"
  border-strong: "rgba(184, 211, 255, 0.18)"
  ink: "#f3f7ff"
  ink-soft: "#aebbd0"
  ink-faint: "#8895a9"
  accent: "#34e5ff"
  signal: "#34e5ff"
  copy: "#4df0a8"
  block: "#ff5f7e"
  warn: "#ffd166"
  cta-bg: "#34e5ff"
  cta-fg: "#06101d"
typography:
  body:
    fontFamily: Bricolage Grotesque
  mono:
    fontFamily: IBM Plex Mono
omitted:
  - spacing
  - rounded
  - components
---

## Overview

Shadow helps people fund agent service purchases, set limits, track repayment and reclaim eligible funds. The participant experience leads with the action the person needs to complete. The public site and participant app use the same dark visual language.

## Colors

Use the background and inset surface for page structure, with raised surfaces for forms and contextual information. Use the accent for the primary action, links and focus. Success uses copy, refusal or failure uses block, and unresolved outcomes use warn. Color always accompanies text or an icon that names the state.

Calculate contrast against the actual surface, including composited transparency. Maintain 4.5:1 for body text and 3:1 for large text and information carrying boundaries. New colors and surfaces require measured contrast before release. The existing primary button pair exceeds those requirements.

## Typography

Use the body family for headings and prose. Reserve mono for data, labels, wallet addresses, hashes and amounts. Keep the two existing families; do not introduce a third without a distinct role. Amounts and changing metrics use tabular figures.

## Layout

Every page must work at 320 CSS pixels without horizontal scrolling, lost content or lost function. Rebuilt participant controls use 44px touch targets. Existing surfaces must at least preserve the WCAG 2.2 AA target size or spacing floor.

Give each onboarding stage its own route and one primary action. Completing a stage leads to the next page; browser Back preserves entered details. Show progress and a contextual summary without repeating the full form on every page. Use a compact mobile progress view rather than compressing desktop navigation into unreadable text.

## Components

The participant journey separates wallet connection, sponsor registration, agent selection, budget settings, funding review and line management. Registration labels must describe the actual sponsor transaction. Registered sponsors can continue without registering again. Agent users can open an existing line without traversing sponsor setup.

Keep one wallet control per screen. Place network and registration prerequisites before funding fields. Give disconnected, loading, paused, pending and failed states a specific explanation and next action. Show repayment terms, provider identity and sponsor risk at the funding decision.

Advance registration or funding only after confirmed state. Each financial action retains its own review and wallet confirmation. Explain declined and failed prompts without claiming a transaction was not sent when its outcome is unknown. Unknown outcomes show recovery of the original request and block a new payment.

Keep the public self service contract and earlier candidate distinct. A friendly agent label must not replace wallet identity or funding line authorization. Show real chain and service state rather than simulated success.

## Do's and Don'ts

Keep animation finite and optional. Do not introduce looping motion. Visibility must not depend on an animation ending. Under reduced motion, disable transitions and animations and turn off smooth scrolling; scripted scrolls use the default behavior. Preserve the existing short interaction transitions.

Do not present a requested wallet action as completed. Do not use state color without a matching label. Do not offer a retry as a new payment while the original outcome is unknown. Do not weaken repayment, wallet or transaction recovery controls for visual convenience.

Every referenced custom property must be defined. Verify actual desktop and mobile flows, keyboard focus, disabled reasons and reduced motion before release.
