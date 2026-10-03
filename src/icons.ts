/**
 * Touch-strip icons for the `$B1` layout, as base64 SVG data URIs.
 *
 * Generic shapes on purpose (no brand logos): a filled disc in the player's colour with
 * its initial. Unknown players get a neutral note glyph; muted players go grey with a
 * slash so the state reads at a glance.
 */

const COLORS: Record<string, string> = {
	spotify: "#1DB954",
	deezer: "#A238FF",
};

const NEUTRAL = "#4A4A4A";
const MUTED = "#6B6B6B";
const FALLBACK = "#3A7BD5";

/** Brand-ish accent for the bar; grey when muted so the state reads even without text. */
export function colorFor(exe: string | null, muted: boolean): string {
	if (!exe) return NEUTRAL;
	if (muted) return MUTED;
	return COLORS[exe.toLowerCase()] ?? FALLBACK;
}

function svg(body: string): string {
	const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">${body}</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(markup).toString("base64")}`;
}

function noteGlyph(color: string): string {
	return `<path fill="${color}" d="M28 10v18.5a6 6 0 1 1-3-5.2V16l-8 2v13.5a6 6 0 1 1-3-5.2V14l14-4z"/>`;
}

export function iconFor(exe: string | null, muted: boolean): string {
	if (!exe) {
		return svg(`<circle cx="24" cy="24" r="22" fill="${NEUTRAL}"/>${noteGlyph("#9A9A9A")}`);
	}

	const color = COLORS[exe.toLowerCase()] ?? FALLBACK;
	const initial = exe.charAt(0).toUpperCase();
	const disc = `<circle cx="24" cy="24" r="22" fill="${muted ? MUTED : color}"/>`;
	const letter = `<text x="24" y="33" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="700" fill="#fff">${initial}</text>`;
	const slash = muted
		? `<line x1="10" y1="38" x2="38" y2="10" stroke="#fff" stroke-width="4" stroke-linecap="round"/>`
		: "";

	return svg(`${disc}${letter}${slash}`);
}
