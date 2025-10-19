import { Plugin, App, Setting, PluginSettingTab } from 'obsidian';

interface ImageManagerSettings {
  isEnabled: boolean;
  targetDirectory: string;
  imagePrefix: string;
  targetNote: string;
}

const DEFAULT_SETTINGS: ImageManagerSettings = {
  isEnabled: true,
  targetDirectory: '',
  imagePrefix: 'prefix',
  targetNote: '',
};

export default class ImageManagerPlugin extends Plugin {
  settings: ImageManagerSettings;

  constructor(app: App, manifest: any) {
    super(app, manifest);
    this.settings = DEFAULT_SETTINGS;
  }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ImageManagerSettingTab(this.app, this));
    this.addCommand({
      id: 'manage-image-attachments',
      name: 'Manage Image Attachments',
      callback: () => this.manageImageAttachments(),
    });
    console.log("Plugin Loaded");
  }

  async manageImageAttachments() {
    if (!this.settings.isEnabled) return;

    const targetNote = await this.getTargetNote();
    if (!targetNote) return;

    const images = await this.getImageAttachments(targetNote);
    if (images.length === 0) return;

    const targetFolder = this.settings.targetDirectory || this.app.vault.getRoot().path;
    await this.ensureTargetFolderExists(targetFolder);

    let updatedContent = await this.app.vault.read(targetNote);
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const newFileName = this.renameFile(image, i + 1);
      updatedContent = updatedContent.replace(`![[${image}]]`, `![[${newFileName}]]`);
      await this.moveFile(image, newFileName, targetFolder);
    }

    await this.app.vault.modify(targetNote, updatedContent);
    console.log("Image management complete.");
  }

  async getTargetNote(): Promise<any> {
    const targetNoteName = this.settings.targetNote;
    if (!targetNoteName) return null;

    const notePath = targetNoteName.endsWith('.md') ? targetNoteName : `${targetNoteName}.md`;
    return this.app.vault.getFiles().find(file => file.path === notePath);
  }

  async getImageAttachments(note: any): Promise<string[]> {
    const content = await this.app.vault.read(note);
    const images: string[] = [];
    const regex = /!\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = regex.exec(content)) !== null) images.push(match[1]);
    return images;
  }

  async ensureTargetFolderExists(folderPath: string): Promise<void> {
    const targetFolder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!targetFolder) await this.app.vault.createFolder(folderPath);
  }

  renameFile(filePath: string, index: number): string {
    const fileName = filePath.split('/').pop();
    const fileExtension = fileName?.split('.').pop();
    return fileName && fileExtension ? `${this.settings.imagePrefix}${index}.${fileExtension}` : `${this.settings.imagePrefix}${index}.unknown`;
  }

  async moveFile(filePath: string, newFileName: string, targetFolder: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) return;

    const newFilePath = `${targetFolder}/${newFileName}`;
    const existingFile = this.app.vault.getAbstractFileByPath(newFilePath);
    if (existingFile) await this.app.vault.delete(existingFile);

    await this.app.vault.rename(file, newFilePath);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    console.log("Image Manager Plugin Unloaded");
  }
}

class ImageManagerSettingTab extends PluginSettingTab {
  plugin: ImageManagerPlugin;

  constructor(app: App, plugin: ImageManagerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Enable/Disable Plugin')
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.isEnabled).onChange(async (value) => {
          this.plugin.settings.isEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Target Directory')
      .addText(text =>
        text.setValue(this.plugin.settings.targetDirectory).onChange(async (value) => {
          this.plugin.settings.targetDirectory = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Image Renaming Prefix')
      .addText(text =>
        text.setValue(this.plugin.settings.imagePrefix).onChange(async (value) => {
          this.plugin.settings.imagePrefix = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Target Note')
      .addText(text =>
        text.setValue(this.plugin.settings.targetNote).onChange(async (value) => {
          this.plugin.settings.targetNote = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
