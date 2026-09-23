export type ServerEvent = {
  event: string;
  data: string;
  id: string;
};

// TextDecoder should retain partial UTF-8 bytes between reads before feeding
// this parser. A chunk may end anywhere, including between CR and LF.
export function createEventParser(onEvent: (event: ServerEvent) => void) {
  let line = "";
  let data: string[] = [];
  let event = "";
  let id = "";
  let skipLf = false;
  let first = true;

  const consumeLine = () => {
    const current = line;
    line = "";
    if (current === "") {
      if (data.length > 0) {
        onEvent({ event: event || "message", data: data.join("\n"), id });
      }
      data = [];
      event = "";
      return;
    }
    if (current.startsWith(":")) return;
    const colon = current.indexOf(":");
    const field = colon < 0 ? current : current.slice(0, colon);
    let value = colon < 0 ? "" : current.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
  };

  return {
    feed(chunk: string) {
      for (const character of chunk) {
        if (first) {
          first = false;
          if (character === "\uFEFF") continue;
        }
        if (skipLf) {
          skipLf = false;
          if (character === "\n") continue;
        }
        if (character === "\r" || character === "\n") {
          consumeLine();
          skipLf = character === "\r";
        } else line += character;
      }
    },
    // An interrupted event is never a receipt: only a blank line dispatches.
    end() {
      line = "";
      data = [];
      event = "";
      skipLf = false;
    },
  };
}
