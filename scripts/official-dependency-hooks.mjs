/** Freeze the externally sealed production closure instead of recollecting or rebuilding it. */
export const officialDependencyHooks = Object.freeze({
  npmRebuild: true,
  nodeGypRebuild: false,
  beforeBuild: async () => false,
});
