import { tethrApi, tethrKeys, type TethrDriveNode, type TethrFsEntry } from "@/api/tethr";

// One file-manager, three backends. Each DriveSource maps the same verbs
// (list / createFolder / rename / move / archive) onto its store: the Google
// Drive-synced "00 Tethr" folder and any added folders are filesystem-backed
// (mount = "mirror" | "ext:<id>"); the internal working drive is the DB
// (tethr_drive_nodes). The FileManager component is store-agnostic.

/** A normalized row the FileManager renders, regardless of backend. */
export interface FmItem {
  /** Stable id: fs → relative path; DB → node id. Also the folder-ref to nav into. */
  key: string;
  name: string;
  kind: "folder" | "file";
  size?: number;
  modifiedAt?: string;
}

export interface DriveSource {
  /** Distinguishes sources in query keys / dnd ids. */
  id: string;
  rootLabel: string;
  /** Filesystem sources allow the "open in Google Drive/Finder" story; DB doesn't. */
  isFs: boolean;
  listKey(folderRef: string): readonly unknown[];
  invalidateKey: readonly unknown[];
  list(folderRef: string): Promise<FmItem[]>;
  createFolder(folderRef: string, name: string): Promise<void>;
  rename(itemKey: string, parentRef: string, newName: string): Promise<void>;
  move(itemKey: string, toFolderRef: string): Promise<void>;
  archive(itemKey: string): Promise<void>;
}

/** Filesystem source (00 Tethr or an added folder). folderRef = relative path; "" = root. */
export function fsSource(companyId: string, mount: string, rootLabel: string): DriveSource {
  const toItem = (e: TethrFsEntry): FmItem => ({
    key: e.path,
    name: e.name,
    kind: e.kind,
    size: e.size,
    modifiedAt: e.modifiedAt,
  });
  return {
    id: mount,
    rootLabel,
    isFs: true,
    listKey: (ref) => tethrKeys.fsList(companyId, mount, ref),
    invalidateKey: ["tethr", companyId, "fsdrive", mount],
    async list(ref) {
      const { entries } = await tethrApi.fsList(companyId, mount, ref);
      return entries.map(toItem);
    },
    createFolder: (ref, name) => tethrApi.fsCreateFolder(companyId, mount, ref, name).then(() => {}),
    // fs rename keeps the item in its current folder (parentRef) with a new name.
    rename: (key, parentRef, newName) =>
      tethrApi.fsMove(companyId, mount, key, parentRef, newName).then(() => {}),
    move: (key, toRef) => tethrApi.fsMove(companyId, mount, key, toRef).then(() => {}),
    archive: (key) => tethrApi.fsArchive(companyId, mount, key).then(() => {}),
  };
}

/** Internal DB drive. folderRef = node id; "" = root (null parent). */
export function internalSource(companyId: string): DriveSource {
  const toItem = (n: TethrDriveNode): FmItem => ({
    key: n.id,
    name: n.name,
    kind: n.kind,
    size: n.byteSize ?? undefined,
    modifiedAt: n.updatedAt,
  });
  return {
    id: "internal",
    rootLabel: "working drive",
    isFs: false,
    listKey: (ref) => tethrKeys.drive(companyId, ref || null),
    invalidateKey: ["tethr", companyId, "drive"],
    async list(ref) {
      const nodes = await tethrApi.drive(companyId, ref || null);
      return nodes.map(toItem);
    },
    createFolder: (ref, name) => tethrApi.createDriveFolder(companyId, ref || null, name).then(() => {}),
    rename: (key, _parentRef, newName) =>
      tethrApi.moveDriveNode(companyId, key, { newName }).then(() => {}),
    move: (key, toRef) => tethrApi.moveDriveNode(companyId, key, { newParentId: toRef || null }).then(() => {}),
    archive: (key) => tethrApi.archiveDriveNode(companyId, key).then(() => {}),
  };
}
