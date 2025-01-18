import { ReplaceStep, Step } from "@tiptap/pm/transform";
import { TextSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Slice, Fragment } from "@tiptap/pm/model";
import {
  Extension,
  Mark,
  getMarkRange,
  getMarksBetween,
  isMarkActive,
  mergeAttributes,
} from "@tiptap/core";
import type { CommandProps, Editor, MarkRange } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";

const LOG_ENABLED = true;

export const MARK_DELETION = "deletion";
export const MARK_INSERTION = "insertion";
export const EXTENSION_NAME = "trackchange";

// Track Change Operations
export const TRACK_COMMAND_ACCEPT = "accept";
export const TRACK_COMMAND_ACCEPT_ALL = "accept-all";
export const TRACK_COMMAND_REJECT = "reject";
export const TRACK_COMMAND_REJECT_ALL = "reject-all";

export type TRACK_COMMAND_TYPE =
  | "accept"
  | "accept-all"
  | "reject"
  | "reject-all";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    trackchange: {
      /**
       * change track change extension enabled status
       * we don't use a external function instead，so we can use a editor.command anywhere without another variable
       * @param enabled
       * @returns
       */
      setTrackChangeStatus: (enabled: boolean) => ReturnType;
      getTrackChangeStatus: () => ReturnType;
      toggleTrackChangeStatus: () => ReturnType;
      /**
       * accept one change: auto recognize the selection or left near by cursor pos
       */
      acceptChange: () => ReturnType;
      /**
       * accept all changes: mark insertion as normal, and remove all the deletion nodes
       */
      acceptAllChanges: () => ReturnType;
      /**
       * same to accept
       */
      rejectChange: () => ReturnType;
      /**
       * same to acceptAll but: remove deletion mark and remove all insertion nodes
       */
      rejectAllChanges: () => ReturnType;
      /**
       *
       */
      updateOpUserOption: (
        opUserId: string,
        opUserNickname: string
      ) => ReturnType;
    };
  }
}

// insert mark
export const InsertionMark = Mark.create({
  name: MARK_INSERTION,
  addAttributes() {
    return {
      "data-op-user-id": {
        type: "string",
        default: () => "",
      },
      "data-op-user-nickname": {
        type: "string",
        default: () => "",
      },
      "data-op-date": {
        type: "string",
        default: () => "",
      },
    };
  },
  parseHTML() {
    return [{ tag: "insert" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "insert",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      0,
    ];
  },
});

// delete mark
export const DeletionMark = Mark.create({
  name: MARK_DELETION,
  addAttributes() {
    return {
      "data-op-user-id": {
        type: "string",
        default: () => "",
      },
      "data-op-user-nickname": {
        type: "string",
        default: () => "",
      },
      "data-op-date": {
        type: "string",
        default: () => "",
      },
    };
  },
  parseHTML() {
    return [{ tag: "delete" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "delete",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      0,
    ];
  },
});

// save the ime-mode status, when input chinese char, the extension needs to deal the change with a special strategy
// TODO: Is it necessary to save these two variable into a tiptap instance when someone open two editor
const IME_STATUS_NORMAL = 0;
const IME_STATUS_START = 1;
const IME_STATUS_CONTINUE = 2;
const IME_STATUS_FINISHED = 3;
type IME_STATUS_TYPE = 0 | 1 | 2 | 3;
let composingStatus: IME_STATUS_TYPE = 0; // 0: normal，1: start with first chat, 2: continue input, 3: finished by confirm or cancel with chars applied
let isStartChineseInput = false;

// get self extension instance by name
const getSelfExt = (editor: Editor) =>
  editor.extensionManager.extensions.find(
    (item) => item.type === "extension" && item.name === EXTENSION_NAME
  ) as Extension;

// get the current minute time, avoid two char with different time splitted with too many marks
const getMinuteTime = () =>
  Math.round(new Date().getTime() / 1000 / 60) * 1000 * 60;

/**
 * accept or reject tracked changes for all content or just the selection
 * @param opType operation to apply
 * @param param a command props, so we can get the editor, tr prop
 * @returns null
 */
const changeTrack = (opType: TRACK_COMMAND_TYPE, param: CommandProps) => {
  /**
   * get the range to deal, use selection default
   */
  const from = param.editor.state.selection.from;
  const to = param.editor.state.selection.to;
  /**
   * find all the mark ranges to deal and remove mark or remove content according by opType
   * if got accept all or reject all, just set 'from' to 0 and 'to' to content size
   * if got just a part range,
   */
  let markRanges: Array<MarkRange> = [];
  /**
   * deal a part and no selection contents, need to recognize the left mark near by cursor
   */
  if (
    (opType === TRACK_COMMAND_ACCEPT || opType === TRACK_COMMAND_REJECT) &&
    from === to
  ) {
    // detect left mark
    const isInsertBeforeCursor = isMarkActive(
      param.editor.state,
      MARK_INSERTION
    );
    const isDeleteBeforeCursor = isMarkActive(
      param.editor.state,
      MARK_DELETION
    );
    let leftRange;
    if (isInsertBeforeCursor) {
      leftRange = getMarkRange(
        param.editor.state.selection.$from,
        param.editor.state.doc.type.schema.marks.insertion
      );
    } else if (isDeleteBeforeCursor) {
      leftRange = getMarkRange(
        param.editor.state.selection.$from,
        param.editor.state.doc.type.schema.marks.deletion
      );
    }
    if (leftRange) {
      markRanges = getMarksBetween(
        leftRange.from,
        leftRange.to,
        param.editor.state.doc
      );
    }
  } else if (
    opType === TRACK_COMMAND_ACCEPT_ALL ||
    opType === TRACK_COMMAND_REJECT_ALL
  ) {
    // all editor content
    markRanges = getMarksBetween(
      0,
      param.editor.state.doc.content.size,
      param.editor.state.doc
    );
    // change the opType to normal
    opType =
      opType === TRACK_COMMAND_ACCEPT_ALL
        ? TRACK_COMMAND_ACCEPT
        : TRACK_COMMAND_REJECT;
  } else {
    // just the selection
    markRanges = getMarksBetween(from, to, param.editor.state.doc);
  }
  // just deal the track change nodes
  markRanges = markRanges.filter(
    (markRange) =>
      markRange.mark.type.name === MARK_DELETION ||
      markRange.mark.type.name === MARK_INSERTION
  );
  if (!markRanges.length) {
    return false;
  }

  const currentTr = param.tr;
  /**
   * mark type and opType compose:
   * 1. accept with insert mark: remove insert mark
   * 2. accept with delete mark: remove content
   * 3. reject with insert mark: remove content
   * 4. reject with delete mark: remove delete mark
   * so
   * 1 and 4 need to remove mark
   * 2 and 3 need to remove content
   */
  // record offset when delete some content to find the correct pos for next range
  let offset = 0;
  const removeInsertMark =
    param.editor.state.doc.type.schema.marks.insertion.create();
  const removeDeleteMark =
    param.editor.state.doc.type.schema.marks.deletion.create();
  markRanges.forEach((markRange) => {
    const isAcceptInsert =
      opType === TRACK_COMMAND_ACCEPT &&
      markRange.mark.type.name === MARK_INSERTION;
    const isRejectDelete =
      opType === TRACK_COMMAND_REJECT &&
      markRange.mark.type.name === MARK_DELETION;
    if (isAcceptInsert || isRejectDelete) {
      // 1 and 4: remove mark
      currentTr.removeMark(
        markRange.from - offset,
        markRange.to - offset,
        removeInsertMark.type
      );
      currentTr.removeMark(
        markRange.from - offset,
        markRange.to - offset,
        removeDeleteMark.type
      );
    } else {
      // 2 and 3 remove content
      currentTr.deleteRange(markRange.from - offset, markRange.to - offset);
      // change the offset
      offset += markRange.to - markRange.from;
    }
  });
  if (currentTr.steps.length) {
    // set a custom meta to tail Our TrackChangeExtension to ignore this change
    // TODO: is there any official field to do this?
    currentTr.setMeta("trackManualChanged", true);
    // apply to current editor state and get a new state
    const newState = param.editor.state.apply(currentTr);
    // update the new state to editor to render new content
    param.editor.view.updateState(newState);
  }
  return false;
};

// @ts-ignore
/**
 * TODO: some problems to fix or feature to implement
 * 1. when delete content includes two and more paragraphs, cannot mark the new paragraph as insert mark, because the mark is inline, can we add global attrs?
 * 2. when delete content includes two and more paragraphs, connot ignore the insert mark inside the content. Currently, the insert mark is marked as deleted. But it need to be delete directly.
 * 3. select two chars and inout a chinese char, the new char was input with wrong position. (fixed by stop input action)
 * 4. how to toggle to "hide" mode and can record the change ranges too, just look likes the office word
 */
export const TrackChangeExtension = Extension.create<{
  enabled: boolean;
  onStatusChange?: Function;
  dataOpUserId?: string;
  dataOpUserNickname?: string;
}>({
  name: EXTENSION_NAME,
  onCreate() {
    if (this.options.onStatusChange) {
      this.options.onStatusChange(this.options.enabled);
    }
  },
  addExtensions() {
    return [InsertionMark, DeletionMark];
  },
  addCommands: () => {
    return {
      setTrackChangeStatus: (enabled: boolean) => (param: CommandProps) => {
        const thisExtension = getSelfExt(param.editor);
        thisExtension.options.enabled = enabled;
        if (thisExtension.options.onStatusChange) {
          thisExtension.options.onStatusChange(thisExtension.options.enabled);
        }
        return false;
      },
      toggleTrackChangeStatus: () => (param: CommandProps) => {
        const thisExtension = getSelfExt(param.editor);
        thisExtension.options.enabled = !thisExtension.options.enabled;
        if (thisExtension.options.onStatusChange) {
          thisExtension.options.onStatusChange(thisExtension.options.enabled);
        }
        return false;
      },
      getTrackChangeStatus: () => (param: CommandProps) => {
        const thisExtension = getSelfExt(param.editor);
        return thisExtension.options.enabled;
      },
      acceptChange: () => (param: CommandProps) => {
        changeTrack("accept", param);
        return false;
      },
      acceptAllChanges: () => (param: CommandProps) => {
        changeTrack("accept-all", param);
        return false;
      },
      rejectChange: () => (param: CommandProps) => {
        changeTrack("reject", param);
        return false;
      },
      rejectAllChanges: () => (param: CommandProps) => {
        changeTrack("reject-all", param);
        return false;
      },
      updateOpUserOption:
        (opUserId: string, opUserNickname: string) => (param: CommandProps) => {
          const thisExtension = getSelfExt(param.editor);
          thisExtension.options.dataOpUserId = opUserId;
          thisExtension.options.dataOpUserNickname = opUserNickname;
          return false;
        },
    };
  },
  // @ts-ignore
  onSelectionUpdate(p) {
    // log the status for debug
    LOG_ENABLED &&
      console.log(
        "selection and input status",
        p.transaction.selection.from,
        p.transaction.selection.to,
        p.editor.view.composing
      );
  },
  // @ts-ignore
  addProseMirrorPlugins(props: { editor: Editor }) {
    return [
      new Plugin({
        key: new PluginKey<any>("composing-check"),
        props: {
          handleDOMEvents: {
            compositionstart: (_event) => {
              LOG_ENABLED && console.log("start chinese input");
              // start and update will fire same time
              isStartChineseInput = true;
            },
            compositionupdate: (_event) => {
              LOG_ENABLED && console.log("chinese input continue");
              composingStatus = IME_STATUS_CONTINUE;
            },
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          // chinese input status check
          const isChineseStart =
            isStartChineseInput && composingStatus === IME_STATUS_CONTINUE;
          const isChineseInputting =
            !isStartChineseInput && composingStatus === IME_STATUS_CONTINUE;
          const isNormalInput = composingStatus === IME_STATUS_NORMAL; // not ime mode
          composingStatus = IME_STATUS_NORMAL; // reset for next change
          isStartChineseInput = false;

          const tr = newState.tr;
          const isThisTrApplied = transactions[0].before !== newState.doc;

          // 状态检查
          if (!transactions.length) {
            return null;
          }
          if (!transactions.some((tr) => tr.docChanged)) {
            return null;
          }

          if (
            transactions.some(
              (tr) =>
                tr.getMeta("trackManualChanged") ||
                tr.getMeta("history$") ||
                (tr.getMeta("y-sync$") && tr.getMeta("y-sync$").isChangeOrigin)
            )
          ) {
            return null;
          }

          if (transactions.some((tr) => !tr.steps.length)) {
            return null;
          }

          const transaction = transactions[0];
          const allSteps = transaction.steps.map((step) =>
            Step.fromJSON(this.editor.state.doc.type.schema, step.toJSON())
          );

          LOG_ENABLED && console.log("allSteps", allSteps);

          // latest cursor pos
          const currentNewPos = tr.selection.from;
          LOG_ENABLED && console.log("currentNewPos", currentNewPos);

          // cursor offset, try to reset the pos in the end process
          let posOffset = 0;
          let hasAddAndDelete = false;
          allSteps.forEach((step: Step, _index: number, _arr: Step[]) => {
            if (step instanceof ReplaceStep) {
              // loss chars
              let delCount = 0;
              if (step.from !== step.to) {
                /**
                 * means some content will be removed, but in this extension, we will reAdd it back
                 * note: if the old content is already 'insert', just let it go.
                 */
                const slice = transaction.docs[_index].slice(
                  step.from,
                  step.to
                );
                slice.content.forEach((node) => {
                  const isInsertNode = node.marks.find(
                    (m) => m.type.name === MARK_INSERTION
                  );
                  if (!isInsertNode) {
                    // sum the none-insert mark size
                    // TODO: nodeSize or size filed? what if the node is a image or some other custom node
                    delCount += node.nodeSize;
                  }
                });
              }
              posOffset += delCount;
              // added chars in this step
              const newCount = step.slice ? step.slice.size : 0;
              if (newCount && delCount) {
                // if only add or del, don't need to change selection, it's already right
                hasAddAndDelete = true;
              }
            }
          });

          if (isNormalInput) {
            // none ime mode
            if (!hasAddAndDelete) {
              // just delete or add, no need to correct cursor
              posOffset = 0;
            }
          } else if (isChineseStart) {
            // first chinese char
            if (hasAddAndDelete) {
              /**
               * input chinese char when a selection content exist
               * need the readd the selected chars, so we need update the cursor
               * but we cannot change the cursor in "inputting time", ,,,,need some more test
               */
              // posOffset -= 1
            } else {
              // just new content, ime software will make it right
              posOffset = 0;
            }
          } else if (isChineseInputting) {
            // chinese input, at least two chars, no need to update cursor
            posOffset = 0;
          }

          LOG_ENABLED &&
            console.table({
              hasAddAndDelete,
              isNormalInput,
              isChineseStart,
              isChineseInputting,
              posOffset,
            });

          const newChangeTr = isThisTrApplied ? tr : transaction;

          let reAddOffset = 0;
          allSteps.forEach((step: Step, index: number) => {
            if (step instanceof ReplaceStep) {
              const invertedStep = step.invert(transaction.docs[index]);
              if (step.slice.size) {
                const insertionMark = newState.schema.marks.insertion.create({
                  "data-op-user-id": this.options.dataOpUserId,
                  "data-op-user-nickname": this.options.dataOpUserNickname,
                  "data-op-date": getMinuteTime(),
                });
                const deletionMark =
                  this.editor.state.doc.type.schema.marks.deletion.create();
                const from = step.from + reAddOffset;
                const to = step.from + reAddOffset + step.slice.size;
                if (this.options.enabled) {
                  // add insert mark to new content
                  newChangeTr.addMark(from, to, insertionMark);
                } else {
                  // if disabled this extension, remove auto-used track mark for new content
                  newChangeTr.removeMark(from, to, insertionMark.type);
                }
                // remove auto-used delete mark for new content anyway
                newChangeTr.removeMark(from, to, deletionMark.type);
              }
              if (step.from !== step.to && this.options.enabled) {
                LOG_ENABLED && console.log("find content to readd", step);
                // get the reverted step, so we can know what content is deleted in this step and readd then
                // make sure use related doc in transaction. every step has the new doc with same order
                // TODO: is there difference between vue2 and vue3
                const skipSteps: Array<ReplaceStep> = [];
                // collect the content we need to ignore readd, because some content is insert mark before, there data need to be allowed delete
                LOG_ENABLED && console.log("invertedStep", invertedStep);
                const reAddStep = new ReplaceStep(
                  invertedStep.from + reAddOffset,
                  invertedStep.from + reAddOffset,
                  invertedStep.slice,
                  // @ts-ignore: what is internal means
                  invertedStep.structure
                );
                // make a empty step to replace the original "INSERT" mark, because these content don't need to readd
                // the slice content maybe a TextNode or other node with any child content
                // so we need to travel all the content to find the "INSERT" mark
                let addedEmptyOffset = 0; // when empty step is added, record the offset to correct the next empty step, because the content will b shorter than the current when create next empty step
                const travelContent = (
                  content: Fragment,
                  parentOffset: number
                ) => {
                  content.forEach((node, offset) => {
                    const start = parentOffset + offset;
                    const end = start + node.nodeSize;
                    if (node.content && node.content.size) {
                      // this node has child content, need to travel
                      travelContent(node.content, start);
                    } else {
                      // this node is a text node, or a node without child content
                      if (
                        node.marks.find((m) => m.type.name === MARK_INSERTION)
                      ) {
                        // construct a empty step, apply this after readd action applied
                        skipSteps.push(
                          new ReplaceStep(
                            start - addedEmptyOffset,
                            end - addedEmptyOffset,
                            Slice.empty
                          )
                        );
                        addedEmptyOffset += node.nodeSize;
                        reAddOffset -= node.nodeSize;
                      }
                    }
                  });
                };
                travelContent(invertedStep.slice.content, invertedStep.from);
                reAddOffset += invertedStep.slice.size;
                // apply readd step action
                newChangeTr.step(reAddStep);
                const { from } = reAddStep;
                const to = from + reAddStep.slice.size;
                // add delete mark for readd content
                newChangeTr.addMark(
                  from,
                  to,
                  newChangeTr.doc.type.schema.marks.deletion.create({
                    "data-op-user-id": this.options.dataOpUserId,
                    "data-op-user-nickname": this.options.dataOpUserNickname,
                    "data-op-date": getMinuteTime(),
                  })
                );
                skipSteps.forEach((step) => {
                  // delete the content if it is already with insert mark
                  newChangeTr.step(step);
                });
              }
              // return newChangeTr
              // TODO: if there has cursor change action, can there change be merged to one tr with one updateState?
              // calculate new cursor postion
              const finalNewPos = this.options.enabled
                ? currentNewPos + posOffset
                : currentNewPos;
              if (this.options.enabled) {
                // const trWithChange = this.editor.view.state.tr;
                newChangeTr.setSelection(
                  TextSelection.create(tr.doc, finalNewPos)
                );
                // const newStateWithNewSelection =
                //   this.editor.view.state.apply(trWithChange);
                LOG_ENABLED && console.log("update cursor", finalNewPos);
                // this.editor.view.updateState(newStateWithNewSelection);
              }
              if (isChineseStart && hasAddAndDelete && this.options.enabled) {
                // if the first chinese input and have some content selected
                // just make it stop by blur action
                // delete the selection and use just need paste the new content again
                this.editor.commands.deleteSelection();
                this.editor.commands.blur();
                setTimeout(() => {
                  // focus again
                  this.editor.commands.focus();
                }, 100);
              }
            }
          });
          if (newChangeTr.steps.length) {
            return newChangeTr;
          }
          return null;
        },
      }),
    ];
  },
});

export default TrackChangeExtension;
