// MARKER: Animated Artwork (Apple Music live artwork in the lyrics view)
//   Renders the API HLS stream over TIDAL's static artwork tile.
//   Orchestration (track change, visibility, settings) lives in index.ts.

import { Tracer } from "@luna/core";
// The light build drops alt-audio, subtitles and EME — none of which a muted
// artwork loop uses — and saves ~230kB of bundle. See hls-light.d.ts for types.
import Hls from "hls.js/light";

import { fetchAnimatedArtwork } from "./api";
import { settings } from "./Settings";

const { trace } = Tracer("[Radiant Lyrics]");

export const ART_TILE_SELECTOR = '[data-test="now-playing-artwork"]';
/** Elements that cannot render child nodes, so the video must go beside them. */
const REPLACED_TAGS = new Set(["IMG", "PICTURE", "VIDEO", "CANVAS", "SVG"]);

export class AnimatedArtworkLayer {
	private video: HTMLVideoElement | null = null;
	private hls: Hls | null = null;
	private tile: HTMLElement | null = null;
	/** Where the video actually lives — the tile itself, or its parent when the tile is a replaced element. */
	private mount: HTMLElement | null = null;
	private resizeObs: ResizeObserver | null = null;
	private resizeRaf = 0;
	private artwork: { url: string; url_tall: string } | null = null;
	/** Identity of the artwork currently mounted (see artworkKey() in index.ts). */
	private artworkKey: string | null = null;
	private liveSrc: string | null = null;
	private loadToken = 0;
	private nowPlayingVisible = true;
	/** True when we set `position: relative` on the mount and owe a revert. */
	private mountPositioned = false;
	/** Aborts the in-flight lookup when the track changes underneath us. */
	private fetchAbort: AbortController | null = null;

	/** Give TIDAL's element back the inline style we found it with. */
	private releaseMount(): void {
		if (this.mount && this.mountPositioned) this.mount.style.removeProperty("position");
		this.mountPositioned = false;
		this.mount = null;
	}

	/** True while a matching artwork tile is alive. */
	private tileAlive(): boolean {
		if (this.tile?.isConnected) return true;
		const tile = document.querySelector<HTMLElement>(ART_TILE_SELECTOR);
		if (!tile) return false;
		this.host(tile);
		return true;
	}

	private host(tile: HTMLElement): void {
		this.tile = tile;
		// TIDAL's artwork tile is an <img>: a replaced element never renders children,
		// so an appended <video> would vanish without error. Host it in the parent and
		// position it over the tile instead.
		const replaced = REPLACED_TAGS.has(tile.tagName);
		const mount = replaced ? tile.parentElement : tile;
		if (mount !== this.mount) this.releaseMount();
		this.mount = mount;
		if (this.mount && getComputedStyle(this.mount).position === "static") {
			// Remember that the inline style is ours so teardown can undo it.
			this.mountPositioned = true;
			this.mount.style.position = "relative";
		}
		this.watchSizing();
	}

	/** Lay the video over the tile when it is not a direct child of it. */
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
		// host() can re-run against a fresh tile, so always re-target the observer.
		this.resizeObs?.disconnect();
		this.resizeObs ??= new ResizeObserver(() => {
			if (!this.artwork || !this.video) return;
			// Deferred to the next frame: syncGeometry reads layout and then writes
			// styles, which inside the callback would retrigger the observer.
			if (this.resizeRaf !== 0) return;
			this.resizeRaf = requestAnimationFrame(() => {
				this.resizeRaf = 0;
				// Only rebuild the stream if the aspect actually flipped.
				if (this.pickSrc() !== this.liveSrc) this.mountVideo(false);
				this.syncGeometry();
			});
		});
		this.resizeObs.observe(this.tile);
	}

	/**
	 * Resolve and mount the artwork identified by `key`. Uses the exact album
	 * first and retries without it on a miss (handled inside the fetch).
	 *
	 * The currently playing video is deliberately left alone until a replacement
	 * is known: animated artwork belongs to the album, so skipping tracks within
	 * one must not tear the video down and refetch it. Returns false when the
	 * attempt could not be completed because no artwork tile was on screen, so
	 * the caller can retry once the view appears.
	 */
	async load(
		key: string,
		title: string,
		artist: string,
		album: string | undefined,
	): Promise<boolean> {
		// Already showing this album's artwork — keep playing, touch nothing.
		if (key === this.artworkKey && this.artwork && this.video?.isConnected) {
			this.ensurePlaying();
			return true;
		}
		const token = ++this.loadToken;
		// Stop the previous lookup from holding a connection open for a track we left.
		this.fetchAbort?.abort();
		this.fetchAbort = new AbortController();
		const signal = this.fetchAbort.signal;

		if (!settings.animatedArtwork) return true;
		// Only confirm a tile exists; hosting happens after the fetch resolves so
		// the outgoing video keeps its mount (and keeps playing) until then.
		if (!document.querySelector<HTMLElement>(ART_TILE_SELECTOR)) return false;

		const artwork = await fetchAnimatedArtwork(title, artist, album, signal);
		if (token !== this.loadToken) return true;
		if (!this.tileAlive()) return false;

		if (!artwork) {
			// A definitive miss — no point retrying when the view remounts.
			trace.log(`AM Artwork: no animated art for "${title}"`);
			this.detach(false);
			// Set after detach(), which clears the key along with the artwork.
			this.artworkKey = key;
			return true;
		}
		// Same stream as what is already on screen (e.g. a compilation whose
		// tracks resolve to one album): adopt the key and leave the video be.
		const unchanged =
			this.artwork?.url === artwork.url &&
			this.artwork?.url_tall === artwork.url_tall &&
			this.video?.isConnected === true;
		this.artwork = artwork;
		this.artworkKey = key;
		if (unchanged) {
			this.ensurePlaying();
			return true;
		}
		this.mountVideo(false);
		return true;
	}

	/** Re-bind to the artwork tile after the Now Playing view (re)mounted. */
	reattach(): void {
		if (!this.artwork || !settings.animatedArtwork) return;
		const tile = document.querySelector<HTMLElement>(ART_TILE_SELECTOR);
		if (!tile) return;
		if (tile === this.tile && this.video?.isConnected) {
			this.ensurePlaying();
			return;
		}
		this.host(tile);
		this.mountVideo(true);
	}

	/** (Re)mount the video into the tile, honouring the current aspect + settings. */
	mountVideo(force: boolean): void {
		if (!this.tileAlive() || !this.artwork || !settings.animatedArtwork) {
			this.detach(false);
			return;
		}
		const src = this.pickSrc();
		if (!this.tile || !this.mount) {
			this.detach(false);
			return;
		}
		if (src === this.liveSrc && this.video && !force) {
			this.ensurePlaying();
			return;
		}
		this.video?.remove();
		this.hls?.destroy();
		this.hls = null;
		this.video = null;
		this.liveSrc = src;

		const video = document.createElement("video");
		video.className = "rl-animated-art";
		video.muted = true;
		video.autoplay = true;
		video.loop = true;
		video.playsInline = true;
		video.crossOrigin = "anonymous";
		video.tabIndex = -1;
		video.setAttribute("aria-hidden", "true");
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

		// MSE first: Chromium answers "maybe" to canPlayType for HLS but then fails
		// the native demuxer on the playlist itself (DEMUXER_ERROR_COULD_NOT_PARSE),
		// so native playback is only a fallback for engines without MSE.
		if (typeof Hls === "function" && Hls.isSupported()) {
			const hls = new Hls({
				autoStartLoad: true,
				// The tile is ~516 CSS px; without this, ABR happily picks Apple's
				// 2160x2160 ladder rung (91MB for a 34s loop, vs 6MB at 768x768)
				// and decodes 4x more pixels than the display can show.
				capLevelToPlayerSize: true,
			});
			this.hls = hls;
			hls.loadSource(src);
			hls.attachMedia(video);
			hls.on(Hls.Events.ERROR, (_evt, data) => {
				if (!data.fatal) return;
				this.fail(
					`hls ${data.type}/${data.details}${data.reason ? ` (${data.reason})` : ""}${data.error ? ` (${data.error.message})` : ""}`,
				);
			});
		} else if (video.canPlayType("application/vnd.apple.mpegurl")) {
			video.src = src;
		} else {
			trace.log("AM Artwork: HLS unsupported on this client");
			this.detach(false);
			return;
		}
		video.classList.add("rl-animated-art-visible");
		this.ensurePlaying();
	}

	private pickSrc(): string {
		if (!this.artwork || !this.tile) return "";
		const rect = this.tile.getBoundingClientRect();
		if (rect.width && rect.height && rect.height > rect.width) {
			return this.artwork.url_tall;
		}
		return this.artwork.url;
	}

	private fail = (reason: string): void => {
		trace.log(`AM Artwork: ${reason} — hiding video (src: ${this.liveSrc})`);
		this.detach(false);
	};

	/** Respect settings + panel visibility when toggling play/pause. */
	ensurePlaying(): void {
		if (
			this.artwork &&
			this.video &&
			settings.animatedArtwork &&
			this.nowPlayingVisible &&
			!document.hidden &&
			this.tile?.isConnected
		) {
			void this.video.play().catch(() => {});
		} else {
			this.video?.pause();
		}
	}

	/** Set whether the Now Playing view is currently visible on screen. */
	setNowPlayingVisible(visible: boolean): void {
		// Called from the 200ms activity tick: bail unless the state actually flipped.
		if (visible === this.nowPlayingVisible) return;
		this.nowPlayingVisible = visible;
		// Re-show has to resume explicitly: the view is hidden by CSS rather than
		// unmounted, so the tile observer never fires and nothing else would restart it.
		this.ensurePlaying();
	}

	/** Keep the video mounted but re-evaluate play state (settings / visibility). */
	refresh(): void {
		if (!this.liveSrc) return;
		if (settings.animatedArtwork) {
			if (this.video) this.ensurePlaying();
			else this.mountVideo(true);
		} else {
			this.detach(true);
		}
	}

	private detach(keepData: boolean): void {
		if (this.video?.parentNode) this.video.remove();
		this.video = null;
		this.hls?.destroy();
		this.hls = null;
		this.liveSrc = keepData ? this.liveSrc : null;
		if (!keepData) {
			this.artwork = null;
			this.artworkKey = null;
		}
	}

	/** Full teardown, including tile references. */
	dispose(): void {
		this.loadToken++;
		this.fetchAbort?.abort();
		this.fetchAbort = null;
		this.resizeObs?.disconnect();
		this.resizeObs = null;
		if (this.resizeRaf !== 0) cancelAnimationFrame(this.resizeRaf);
		this.resizeRaf = 0;
		// detach(true) keeps nothing on disk, but we are disposing
		this.detach(false);
		this.releaseMount();
		this.tile = null;
	}
}