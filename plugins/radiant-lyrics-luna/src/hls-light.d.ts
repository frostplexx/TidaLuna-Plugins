// hls.js only types its main entry, reuse them here
declare module "hls.js/light" {
	export * from "hls.js";
	export { default } from "hls.js";
}
