/**
 * Minimal ambient typings for Drawflow 0.0.60 (the library ships no types).
 * Only the surface pipeline-flow.ts uses is declared.
 */
declare module "drawflow" {
  export interface DrawflowNode {
    readonly pos_x: number;
    readonly pos_y: number;
    readonly data: Record<string, unknown>;
  }

  export default class Drawflow {
    constructor(container: HTMLElement);
    reroute: boolean;
    editor_mode: "edit" | "fixed" | "view";
    zoom: number;
    canvas_x: number;
    canvas_y: number;
    start(): void;
    clear(): void;
    addNode(
      name: string,
      inputs: number,
      outputs: number,
      posX: number,
      posY: number,
      className: string,
      data: Record<string, unknown>,
      html: string,
      typenode: boolean,
    ): number;
    addConnection(
      outputId: number | string,
      inputId: number | string,
      outputClass: string,
      inputClass: string,
    ): void;
    removeSingleConnection(
      outputId: number | string,
      inputId: number | string,
      outputClass: string,
      inputClass: string,
    ): boolean;
    getNodeFromId(id: number | string): DrawflowNode;
    export(): { drawflow: { Home: { data: Record<string, unknown> } } };
    /** Callbacks are event-specific; `never` keeps call sites type-checked. */
    on(event: string, callback: (data: never) => void): void;
  }
}
