import {
  Plugin,
  App,
  TFile,
  TFolder,
  normalizePath,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
} from "obsidian";

interface FolderRenamerSettings {
  imagePrefix: string;
  targetDirectory: string;            // save/move here
  referenceDirectory?: string;        // index reference (defaults to target)
  targetedNotePath?: string;          // strict: only images referenced by this note
  scoopVaultRoot?: boolean;           // fallback when no targeted note
}

const DEFAULT_SETTINGS: FolderRenamerSettings = {
  imagePrefix: "T",
  targetDirectory: "",
  referenceDirectory: "",
  targetedNotePath: "",
  scoopVaultRoot: true,
};

export default class FolderImageRenamerPlugin extends Plugin {
  settings: FolderRenamerSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "rename-images-in-target-folder",
      name: "Rename all images in target folder by prefix (directory-based)",
      callback: () => this.renameImagesInTargetFolder(),
    });

    this.addCommand({
      id: "open-image-renamer-gui",
      name: "Open Image Renamer GUI",
      callback: () => new RenamerModal(this.app, this).open(),
    });

    // @ts-ignore exists at runtime
    this.addRibbonIcon?.("wand-2", "Image Renamer", () => {
      new RenamerModal(this.app, this).open();
    });

    this.addSettingTab(new RenamerSettingTab(this.app, this));
    console.log("🧩 FolderImageRenamerPlugin loaded");
  }

  /** === Core renaming logic (clean & compact, preserves all behavior) === */
  async renameImagesInTargetFolder() {
    const s = this.settings;
    const prefix = (s.imagePrefix ?? "").trim();
    const targetDir = (s.targetDirectory ?? "").trim();
    const refDir = (s.referenceDirectory ?? "").trim() || targetDir;
    const notePath = (s.targetedNotePath ?? "").trim();
    const scoopRoot = !!s.scoopVaultRoot;

    if (!prefix) return new Notice("No prefix specified.");
    if (!targetDir) return new Notice("No Save directory (Target).");

    const asFolder = (p: string, label: string) => {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(p));
      if (!(f instanceof TFolder)) throw new Notice(`${label} not found: ${p}`);
      return f;
    };
    let targetFolder: TFolder, refFolder: TFolder;
    try {
      targetFolder = asFolder(targetDir, "Target directory");
      refFolder = asFolder(refDir, "Reference directory");
    } catch { return; }

    const isImg = (e: string) => /^(png|jpg|jpeg|gif|bmp|svg|webp)$/i.test(e ?? "");

    // reference-only index (start 0; max+1)
    const refFiles = refFolder.children.filter((f): f is TFile => f instanceof TFile);
    const usedNames = new Set(refFiles.map(f => f.name));
    const re = new RegExp(`^${this.escapeRegExp(prefix)}(\\d*)\\.[^.]+$`);
    let next = refFiles.reduce((m, f) => {
      const g = f.name.match(re)?.[1];
      const n = g === undefined ? null : g === "" ? 0 : parseInt(g, 10);
      return Number.isFinite(n) ? Math.max(m, n as number) : m;
    }, -1) + 1;

    // gather candidates
    const seen = new Set<string>();
    const candidates: TFile[] = [];
    const push = (f: TFile) => {
      if (!isImg(f.extension)) return;
      if (f.basename.startsWith(prefix)) return;
      if (seen.has(f.path)) return;
      seen.add(f.path); candidates.push(f);
    };

    if (notePath) {
      const note = this.app.vault.getAbstractFileByPath(normalizePath(notePath));
      if (!(note instanceof TFile) || note.extension.toLowerCase() !== "md")
        return new Notice(`Targeted note not found or not a markdown file: ${notePath}`);
      this.getImagesReferencedInNote(note).forEach(push);
    } else {
      targetFolder.children.forEach(f => f instanceof TFile && push(f));
      if (scoopRoot) this.app.vault.getFiles().forEach(f => !f.path.includes("/") && push(f));
    }

    if (!candidates.length) {
      new Notice(`No unprefixed images to rename. Index = ${next}.`, 2000);
      return;
    }

    // stable order (oldest → newest)
    candidates.sort((a, b) =>
      ((a as any).stat?.ctime ?? 0) - ((b as any).stat?.ctime ?? 0) ||
      ((a as any).stat?.mtime ?? 0) - ((b as any).stat?.mtime ?? 0) ||
      a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: "base" })
    );

    // rename/move into target (link-aware)
    for (const file of candidates) {
      const ext = file.extension ? `.${file.extension}` : ".png";
      let name = `${prefix}${next}${ext}`;
      while (usedNames.has(name)) { next++; name = `${prefix}${next}${ext}`; }
      await this.app.fileManager.renameFile(file, normalizePath(`${targetFolder.path}/${name}`));
      usedNames.add(name);
      next++;
    }

    new Notice(`Done. Next will start from ${prefix}${next}`, 2000);
  }

  /** Images referenced/embedded in a markdown note */
  private getImagesReferencedInNote(note: TFile): TFile[] {
    const cache = this.app.metadataCache.getFileCache(note);
    const out: TFile[] = [];
    const seen = new Set<string>();
    const take = (raw: string) => {
      if (!raw) return;
      let core = raw;
      const p = core.indexOf("|"); if (p >= 0) core = core.slice(0, p);
      const h = core.indexOf("#"); if (h >= 0) core = core.slice(0, h);
      const dest = this.app.metadataCache.getFirstLinkpathDest(core, note.path);
      if (dest instanceof TFile) {
        const ext = dest.extension?.toLowerCase() ?? "";
        if (/(png|jpg|jpeg|gif|bmp|svg|webp)$/.test(ext) && !seen.has(dest.path)) {
          seen.add(dest.path); out.push(dest);
        }
      }
    };
    for (const e of cache?.embeds ?? []) take(e.link);
    for (const l of cache?.links ?? []) take(l.link);
    return out;
  }

  escapeRegExp(str: string) { return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
  onunload() { console.log("🧹 FolderImageRenamerPlugin unloaded"); }
}

/** ===== Settings Tab ===== */
class RenamerSettingTab extends PluginSettingTab {
  plugin: FolderImageRenamerPlugin;
  constructor(app: App, plugin: FolderImageRenamerPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Image Renamer Settings" });

    new Setting(containerEl)
      .setName("Prefix")
      .addText(t => t.setPlaceholder("T")
        .setValue(this.plugin.settings.imagePrefix)
        .onChange(async v => { this.plugin.settings.imagePrefix = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Save directory (Target)")
      .addText(t => t.setPlaceholder("assets/images")
        .setValue(this.plugin.settings.targetDirectory)
        .onChange(async v => { this.plugin.settings.targetDirectory = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Reference directory (optional)")
      .setDesc("Used ONLY to compute the next index. Leave blank to use Save directory.")
      .addText(t => t.setPlaceholder("(leave blank to use Save directory)")
        .setValue(this.plugin.settings.referenceDirectory ?? "")
        .onChange(async v => { this.plugin.settings.referenceDirectory = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Targeted note (strict)")
      .setDesc("Path to the .md file; ONLY images referenced in this note are processed.")
      .addText(t => t.setPlaceholder("folder/My Note.md")
        .setValue(this.plugin.settings.targetedNotePath ?? "")
        .onChange(async v => { this.plugin.settings.targetedNotePath = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Also collect from Vault root (fallback)")
      .setDesc("Used only when no Targeted note is set.")
      .addToggle(tg => tg.setValue(!!this.plugin.settings.scoopVaultRoot)
        .onChange(async v => { this.plugin.settings.scoopVaultRoot = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .addButton(b => b.setButtonText("Run now").setCta().onClick(async () => {
        await this.plugin.renameImagesInTargetFolder();
      }));
  }
}

/** ===== Modal (run-time GUI) ===== */
class RenamerModal extends Modal {
  plugin: FolderImageRenamerPlugin;
  constructor(app: App, plugin: FolderImageRenamerPlugin) { super(app); this.plugin = plugin; }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty(); contentEl.createEl("h3", { text: "Image Renamer" });

    let prefix = this.plugin.settings.imagePrefix ?? "";
    let target = this.plugin.settings.targetDirectory ?? "";
    let reference = this.plugin.settings.referenceDirectory ?? "";
    let targetedNotePath = this.plugin.settings.targetedNotePath ?? "";
    let scoop = !!this.plugin.settings.scoopVaultRoot;

    new Setting(contentEl).setName("Prefix")
      .addText(t => t.setPlaceholder("T").setValue(prefix).onChange(v => prefix = v.trim()));
    new Setting(contentEl).setName("Save directory (Target)")
      .addText(t => t.setPlaceholder("assets/images").setValue(target).onChange(v => target = v.trim()));
    new Setting(contentEl).setName("Reference directory (optional)")
      .setDesc("Leave blank to use Save directory")
      .addText(t => t.setPlaceholder("(blank = Save directory)").setValue(reference).onChange(v => reference = v.trim()));
    new Setting(contentEl).setName("Targeted note (strict)")
      .setDesc("Path to the .md file; only images referenced in this note will be processed")
      .addText(t => t.setPlaceholder("folder/My Note.md").setValue(targetedNotePath).onChange(v => targetedNotePath = v.trim()));
    new Setting(contentEl).setName("Also collect from Vault root (fallback)")
      .setDesc("Used only if Targeted note is empty")
      .addToggle(tg => tg.setValue(scoop).onChange(v => scoop = v));

    const actions = new Setting(contentEl);
    actions.addButton(b => b.setButtonText("Run").setCta().onClick(async () => {
      this.plugin.settings.imagePrefix = prefix;
      this.plugin.settings.targetDirectory = target;
      this.plugin.settings.referenceDirectory = reference;
      this.plugin.settings.targetedNotePath = targetedNotePath;
      this.plugin.settings.scoopVaultRoot = scoop;
      await this.plugin.saveSettings();
      await this.plugin.renameImagesInTargetFolder();
      this.close();
    }));
    actions.addButton(b => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void { this.contentEl.empty(); }
}
