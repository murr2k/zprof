// SPDX-License-Identifier: Apache-2.0
/** Rail icons: 24 px stroke glyphs drawn in currentColor, so they follow the theme. */
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const ICONS: Record<string, string> = {
  insights: svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.1V17h5v-1.1c0-.8.4-1.5 1.1-2.1A6 6 0 0 0 12 3z"/>'),
  live: svg('<path d="M3 12h4l2-6 4 12 2-6h6"/>'),
  trace: svg('<path d="M5.5 3v18M12 3v18M18.5 3v18" opacity=".45"/><rect x="4" y="4" width="3" height="5" rx="1"/><rect x="10.5" y="9" width="3" height="6" rx="1"/><rect x="17" y="14" width="3" height="5" rx="1"/><path d="M7 6.5h3.5M13.5 12h3.5"/>'),
  timing: svg('<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  objects: svg('<circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7.4 6h9.2M6.3 8.1l4.4 7.8M17.7 8.1l-4.4 7.8"/>'),
  memory: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>'),
  headroom: svg('<path d="M2 20l6-10 4 6 3-4 7 8z"/><path d="M2 8h20" stroke-dasharray="2 2.5"/>'),
  profile: svg('<rect x="3" y="16" width="18" height="4" rx="1"/><rect x="5" y="11" width="11" height="4" rx="1"/><rect x="7" y="6" width="5" height="4" rx="1"/>'),
  tune: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  soak: svg('<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>'),
  helix: svg('<path d="M6 3.5c8 0 12 1.6 12 3.4S6 10.5 6 12.3s12 1.8 12 3.6-4 3.6-12 3.6"/><path d="M12 2v20" opacity=".45"/>'),
  compare: svg('<path d="M4 20V10M9 20V4M15 20V8M20 20v-7"/>'),
  collapse: svg('<path d="M15 6l-6 6 6 6"/>'),
}
