export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.STEWARD_EXPERIMENTAL === "1";
}
