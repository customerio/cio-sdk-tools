import { MobileProject } from './projects';

export class Context {
  static instance: Context;

  public static create(project: MobileProject): Context {
    Context.instance = new Context(project);
    return Context.instance;
  }

  public static get(): Context {
    return Context.instance;
  }

  public readonly projectPath?: string;
  public readonly project: MobileProject;

  private constructor(project: MobileProject) {
    this.project = project;
  }
}
