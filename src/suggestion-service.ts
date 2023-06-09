import { readdir, lstat, readFile } from "node:fs/promises";
import ignore, { Ignore } from "ignore";
import type { Stats } from "fs";
import * as path from "path";
import * as fs from "fs";
import axios from "axios";

import { File, Folder, Suggestion, SuggestionType } from "./types";

export class SuggestionsService {
  private readonly staticFilters = [
    ".git",
    ".vscode",
    "node_modules",
    "*.json",
    "*.lock",
    "*.md",
    ".gitignore",
  ];
  private readonly ig: Ignore;
  private readonly filter: (pathname: string) => boolean;

  public filePathToFileMap: Map<string, File> = new Map();
  public folderPathToFolderMap: Map<string, Folder> = new Map();

  public count = 0;

  constructor(private readonly workspaceRoot: string) {
    try {
      const rules = fs
        .readFileSync(path.join(this.workspaceRoot, ".gitignore"), "utf-8")
        .split("\n");
      this.ig = ignore().add(rules).add(this.staticFilters);
    } catch (e) {
      console.error(`Error reading .gitignore: ${e}`);
      this.ig = ignore();
    }

    this.filter = this.ig.createFilter();
  }

  async buildFolderStructureAndGenerateSuggestions(
    folder: Folder
  ): Promise<typeof folder.totalSuggestions> {
    console.log(`Building folder structure for ${folder.folderPath}`);

    this.folderPathToFolderMap.set(folder.folderPath, folder);

    const items = await readdir(folder.folderPath);
    const paths = items
      .filter(this.filter)
      .map((item) => path.join(folder.folderPath, item));
    const stats: [string, Stats][] = await Promise.all(
      paths.map(async (item) => [item, await lstat(item)])
    );

    folder.files = stats
      .filter(([, stat]) => stat.isFile())
      .map(([filePath]) => new File(filePath, folder));
    folder.folders = stats
      .filter(([, stat]) => stat.isDirectory())
      .map(([folderPath]) => new Folder(folderPath, folder));

    // Generate suggestions for the files
    for (const file of folder.files) {
      this.filePathToFileMap.set(file.filePath, file);
      file.suggestions = await this.fetchSuggestionsForFile(file);
      for (const suggestion of file.suggestions) {
        folder.totalSuggestions[suggestion.suggestionType] += 1;
      }
    }

    // Create the folder objects and recurse
    for (const childFolder of folder.folders) {
      const totalSuggestions =
        await this.buildFolderStructureAndGenerateSuggestions(childFolder);
      folder.totalSuggestions[SuggestionType.migration] +=
        totalSuggestions[SuggestionType.migration];
      folder.totalSuggestions[SuggestionType.batching] +=
        totalSuggestions[SuggestionType.batching];
      folder.totalSuggestions[SuggestionType.forum] +=
        totalSuggestions[SuggestionType.forum];
    }

    return folder.totalSuggestions;
  }

  private async fetchSuggestionsForFile(file: File): Promise<Suggestion[]> {
    // read file as string
    const fileContent = (await readFile(file.filePath)).toString();
    console.log("fileContent", fileContent);

    const { data } = await axios.post(`http://localhost:4000/api`, {
      fileContent,
    });

    const { suggestionsData, bacthingData, forumPostsData } = data;
    const suggestions: Suggestion[] = [];

    // regex find in file
    const regex =
      /Replace:\n```javascript\n([\s\S]*?)```\nWith:\n```javascript\n([\s\S]*?)```\nExplanation: ([\s\S]*?)(?=Replace:|$)/g;

    let result = suggestionsData.matchAll(regex);
    for (const match of result) {
      const lineByLine = fileContent.split("\n");
      const lineNo = lineByLine.findIndex((line) =>
        line.includes(match[1].trim())
      );
      suggestions.push(
        new Suggestion(
          file,
          lineNo,
          match[3],
          match[2],
          SuggestionType.migration
        )
      );
    }

    let bacthingResult = bacthingData.matchAll(regex);
    for (const match of bacthingResult) {
      const lineByLine = fileContent.split("\n");
      suggestions.push(
        new Suggestion(
          file,
          lineByLine.length - 5,
          match[3],
          match[2],
          SuggestionType.batching
        )
      );
    }

    const forumRegex =
      /\d+\.\s\[(.+?)\]\((https:\/\/forum\.biconomy\.io\/.+?)\)/g;
    let forumPostsResult = forumPostsData.matchAll(forumRegex);
    for (const match of forumPostsResult) {
      const lineByLine = fileContent.split("\n");
      const suggestion = new Suggestion(
        file,
        lineByLine.length - 7,
        match[1],
        match[2],
        SuggestionType.forum
      );
      suggestion.documentationLink = match[2];
      suggestions.push(suggestion);
    }

    return suggestions;
  }
}
