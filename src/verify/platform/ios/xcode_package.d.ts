/**
 * The `xcode` package ships no types — doctor gets by with a `@ts-ignore` at its import.
 * Declaring the sliver of surface the verify path actually touches keeps the project model
 * type-checked instead of `any` all the way down.
 */
declare module 'xcode' {
  // The pbxproj object graph is heterogeneous by nature; each section is keyed by uuid.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type PbxObjects = Record<string, any>;

  interface PbxProject {
    parseSync(): void;
    pbxNativeTargetSection(): PbxObjects;
    hash: { project: { objects: PbxObjects } };
  }

  const xcode: { project(pbxprojPath: string): PbxProject };
  export default xcode;
}
