// MARKER: Animated Artwork (live artwork in the lyrics view)
//   Layer finds the art, surfaces draw it on covers.
//   Orchestration (track change, visibility, settings) lives in index.ts.

import { Tracer } from "@luna/core";
// Light build: no alt-audio/subtitles/EME needed here. Types in hls-light.d.ts.
import Hls from "hls.js/light";

import {
	type AnimatedArtwork,
	artworkTitleKey,
	fetchAnimatedArtwork,
} from "./api";
import { settings } from "./Settings";

const { trace } = Tracer("[Radiant Lyrics]");

export const ART_TILE_SELECTOR = '[data-test="now-playing-artwork"]';
// Player bar thumbnail
export const MINI_ART_SELECTOR =
	'[data-test="footer-player"] [data-test="current-media-imagery"] img';
// Can't hold children, so the video goes beside them
const REPLACED_TAGS = new Set(["IMG", "PICTURE", "VIDEO", "CANVAS", "SVG"]);
// Skip the 2160px rung (91MB a loop)
const ART_MAX_DPR = 1;
const ART_NATIVE_FPS = 25;
// Same as the CSS fade
const ART_FADE_MS = 300;

// One video per cover, moved (not rebuilt) on remount
class ArtworkSurface {
	private video: HTMLVideoElement | null = null;
	private hls: Hls | null = null;
	private tile: HTMLElement | null = null;
	// The tile, or its parent for replaced elements
	private mount: HTMLElement | null = null;
	/** True when the mount's inline position is ours to revert. */
	private mountPositioned = false;
	private resizeObs: ResizeObserver | null = null;
	private resizeRaf = 0;
	private artwork: AnimatedArtwork | null = null;
	private liveSrc: string | null = null;
	// Errored stream, skipped until the art changes
	private failedSrc: string | null = null;
	private fadeTimer = 0;
	private visible = true;
	private nativeFps = ART_NATIVE_FPS;

	constructor(
		private readonly selector: string,
		// Use the tall stream on portrait covers
		private readonly allowTall: boolean,
	) {}

	// Show art, or fade out on null
	show(artwork: AnimatedArtwork | null): void {
		if (artwork?.url !== this.artwork?.url) this.failedSrc = null;
		this.artwork = artwork;
		if (artwork) this.bind();
		else this.fadeOut();
	}

	// Attach to the cover on screen (moves, never rebuilds)
	bind(): void {
		if (!this.artwork || !settings.animatedArtwork) return;
		const tile = document.querySelector<HTMLElement>(this.selector);
		if (!tile) return;
		if (tile !== this.tile) this.host(tile);
		if (!this.mount) return;
		const src = this.pickSrc();
		if (src === this.failedSrc) return;
		if (!this.video || src !== this.liveSrc) {
			this.build(src);
			return;
		}
		// Came back mid fade, keep it
		if (this.fadeTimer !== 0) {
			clearTimeout(this.fadeTimer);
			this.fadeTimer = 0;
			if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
				this.video.classList.add("rl-animated-art-visible");
			}
		}
		// Moving keeps the buffered stream
		if (this.video.parentNode !== this.mount) this.mount.appendChild(this.video);
		this.syncGeometry();
		this.ensurePlaying();
	}

	setVisible(visible: boolean): void {
		// 200ms tick, bail unless it flipped
		if (visible === this.visible) return;
		this.visible = visible;
		// Must resume explicitly; nothing else restarts a paused video.
		this.ensurePlaying();
	}

	// Is the cover on screen
	tileVisible(): boolean {
		const tile = this.tile;
		if (!tile?.isConnected) return false;
		if (typeof tile.checkVisibility === "function") {
			return tile.checkVisibility({ checkVisibilityCSS: true });
		}
		return getComputedStyle(tile).visibility !== "hidden";
	}

	refresh(): void {
		this.applyRate();
		this.ensurePlaying();
	}

	ensurePlaying(): void {
		const video = this.video;
		if (!video) return;
		if (
			this.artwork &&
			settings.animatedArtwork &&
			this.visible &&
			video.isConnected
		) {
			void video.play().catch(() => {});
		} else {
			video.pause();
		}
	}

	dispose(): void {
		this.artwork = null;
		this.failedSrc = null;
		this.teardown();
		this.resizeObs?.disconnect();
		this.resizeObs = null;
		if (this.resizeRaf !== 0) cancelAnimationFrame(this.resizeRaf);
		this.resizeRaf = 0;
		this.releaseMount();
		this.tile = null;
	}

	private build(src: string): void {
		this.teardown();
		if (!this.mount) return;
		this.liveSrc = src;

		const video = document.createElement("video");
		video.className = "rl-animated-art";
		video.muted = true;
		video.loop = true;
		video.playsInline = true;
		video.crossOrigin = "anonymous";
		video.tabIndex = -1;
		video.setAttribute("aria-hidden", "true");
		// Fade in once the first frame is ready
		video.addEventListener(
			"loadeddata",
			() => video.classList.add("rl-animated-art-visible"),
			{ once: true },
		);
		video.addEventListener(
			"error",
			() => {
				const err = video.error;
				this.fail(
					err ? `media error ${err.code}: ${err.message}` : "media error",
				);
			},
			{ once: true },
		);
		this.mount.appendChild(video);
		this.video = video;
		this.syncGeometry();

		// hls.js only, native HLS is broken in Chromium
		if (typeof Hls === "function" && Hls.isSupported()) {
			const hls = new Hls({
				autoStartLoad: true,
				capLevelToPlayerSize: true,
				// H.264 ladder; the artwork has no use for 10-bit HEVC.
				videoPreference: { videoCodec: "avc1", allowedVideoRanges: ["SDR"] },
				maxDevicePixelRatio: ART_MAX_DPR,
			});
			this.hls = hls;
			hls.loadSource(src);
			hls.attachMedia(video);
			hls.on(Hls.Events.LEVEL_SWITCHED, () => {
				const fps = hls.levels[hls.currentLevel]?.frameRate;
				if (fps && fps > 0) this.nativeFps = fps;
				this.applyRate();
			});
			hls.on(Hls.Events.ERROR, (_evt, data) => {
				if (!data.fatal) return;
				this.fail(
					`hls ${data.type}/${data.details}${data.reason ? ` (${data.reason})` : ""}${data.error ? ` (${data.error.message})` : ""}`,
				);
			});
		} else {
			trace.log("Animated Artwork: HLS unsupported on this client");
			this.failedSrc = src;
			this.teardown();
			return;
		}
		this.applyRate();
		this.ensurePlaying();
	}

	// FPS is the only CPU knob
	private applyRate(): void {
		if (!this.video) return;
		const target = Number(settings.animatedArtworkFps) || ART_NATIVE_FPS;
		const rate = Math.min(1, Math.max(0.05, target / this.nativeFps));
		if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
	}

	// Fade out, then drop the video
	private fadeOut(): void {
		const video = this.video;
		if (!video || this.fadeTimer !== 0) return;
		video.classList.remove("rl-animated-art-visible");
		this.fadeTimer = window.setTimeout(() => {
			this.fadeTimer = 0;
			if (this.video === video) this.teardown();
		}, ART_FADE_MS);
	}

	private teardown(): void {
		if (this.fadeTimer !== 0) clearTimeout(this.fadeTimer);
		this.fadeTimer = 0;
		this.video?.remove();
		this.video = null;
		this.hls?.destroy();
		this.hls = null;
		this.liveSrc = null;
		this.nativeFps = ART_NATIVE_FPS;
	}

	private fail = (reason: string): void => {
		trace.log(`Animated Artwork: ${reason} — hiding video (src: ${this.liveSrc})`);
		this.failedSrc = this.liveSrc;
		this.teardown();
	};

	private pickSrc(): string {
		if (!this.artwork) return "";
		if (this.allowTall && this.tile) {
			const rect = this.tile.getBoundingClientRect();
			if (rect.width && rect.height && rect.height > rect.width) {
				return this.artwork.url_tall;
			}
		}
		return this.artwork.url;
	}

	private host(tile: HTMLElement): void {
		this.tile = tile;
		// Covers are <img>s, so host the video in the parent
		const replaced = REPLACED_TAGS.has(tile.tagName);
		const mount = replaced ? tile.parentElement : tile;
		if (mount !== this.mount) this.releaseMount();
		this.mount = mount;
		if (this.mount && getComputedStyle(this.mount).position === "static") {
			this.mountPositioned = true;
			this.mount.style.position = "relative";
		}
		this.watchSizing();
	}

	private releaseMount(): void {
		if (this.mount && this.mountPositioned) this.mount.style.removeProperty("position");
		this.mountPositioned = false;
		this.mount = null;
	}

	// Lay the video over the tile
	private syncGeometry(): void {
		const { video, tile, mount } = this;
		if (!video || !tile || !mount) return;
		if (mount === tile) return;
		video.style.left = `${tile.offsetLeft}px`;
		video.style.top = `${tile.offsetTop}px`;
		video.style.width = `${tile.offsetWidth}px`;
		video.style.height = `${tile.offsetHeight}px`;
		video.style.right = "auto";
		video.style.bottom = "auto";
		video.style.borderRadius = getComputedStyle(tile).borderRadius;
	}

	private watchSizing(): void {
		if (!this.tile) return;
		// host() can re-run against a fresh tile.
		this.resizeObs?.disconnect();
		this.resizeObs ??= new ResizeObserver(() => {
			if (!this.artwork || !this.video) return;
			// Deferred: syncGeometry writes styles and would retrigger us.
			if (this.resizeRaf !== 0) return;
			this.resizeRaf = requestAnimationFrame(() => {
				this.resizeRaf = 0;
				// Only rebuild the stream if the aspect actually flipped.
				if (this.pickSrc() !== this.liveSrc) this.bind();
				this.syncGeometry();
			});
		});
		this.resizeObs.observe(this.tile);
	}
}

export interface ArtworkTrack {
	trackId: string;
	title: string;
	artist: string;
	album?: string;
	isrc?: string;
}

// Finds art for the playing track, feeds every cover
export class AnimatedArtworkLayer {
	private readonly nowPlaying = new ArtworkSurface(ART_TILE_SELECTOR, true);
	private readonly mini = new ArtworkSurface(MINI_ART_SELECTOR, false);
	private readonly surfaces = [this.nowPlaying, this.mini];
	private trackId: string | null = null;
	// Album key if album matched, else title key
	private artworkKey: string | null = null;
	private loadToken = 0;
	private fetchAbort: AbortController | null = null;

	// Called on track change
	async setTrack(track: ArtworkTrack, albumKey: string): Promise<void> {
		// Same track, keep playing
		if (track.trackId === this.trackId) {
			this.rebind();
			return;
		}
		this.trackId = track.trackId;
		const token = ++this.loadToken;
		this.fetchAbort?.abort();
		this.fetchAbort = null;

		// Same album art, nothing to fetch
		if (
			this.artworkKey !== null &&
			(albumKey === this.artworkKey ||
				artworkTitleKey(track.artist, track.title) === this.artworkKey)
		) {
			this.rebind();
			return;
		}

		// New art, drop the old video now
		this.apply(null, null);

		const abort = new AbortController();
		this.fetchAbort = abort;
		const lookup = await fetchAnimatedArtwork(
			track.title,
			track.artist,
			track.album,
			track.isrc,
			abort.signal,
		);
		if (token !== this.loadToken) return;
		this.fetchAbort = null;
		if (!lookup.artwork) {
			trace.log(`Animated Artwork: no animated art for "${track.title}"`);
		}
		this.apply(lookup.artwork, lookup.key);
	}

	// Rebind after TIDAL remounts a cover
	rebind(): void {
		for (const surface of this.surfaces) surface.bind();
	}

	// Called from the 200ms tick
	syncVisibility(nowPlayingVisible: boolean): void {
		const pageVisible = !document.hidden;
		this.nowPlaying.setVisible(pageVisible && nowPlayingVisible);
		this.mini.setVisible(pageVisible && this.mini.tileVisible());
	}

	// FPS setting changed
	refresh(): void {
		for (const surface of this.surfaces) surface.refresh();
	}

	dispose(): void {
		this.loadToken++;
		this.fetchAbort?.abort();
		this.fetchAbort = null;
		this.trackId = null;
		this.artworkKey = null;
		for (const surface of this.surfaces) surface.dispose();
	}

	private apply(artwork: AnimatedArtwork | null, key: string | null): void {
		this.artworkKey = key;
		for (const surface of this.surfaces) surface.show(artwork);
	}
}
