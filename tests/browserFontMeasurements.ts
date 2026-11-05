import { BitmapFontManager, TextStyle } from "pixi.js";
import type { MessageRing } from "../src/chat/ring";

export async function checkFontMeasurements(ring: MessageRing, changeFont: (family: string) => Promise<void>) {
  const owner = ring as unknown as { fontSize: number; measureBitmapTextWidth: (family: string, text: string, size: number) => number };
  const text = "WWW iii AV Й🙂";
  for (const family of ["monospace", "serif", "monospace"]) {
    await changeFont(family);
    for (const name of ["ChatFont", "ChatNickFont"]) {
      const style = new TextStyle({ fontFamily: name, fontSize: owner.fontSize, fill: "#ffffff" });
      const reference = BitmapFontManager.measureText(text, style, false);
      const expected = reference.width * reference.scale;
      const actual = owner.measureBitmapTextWidth(name, text, owner.fontSize);
      if (Math.abs(actual - expected) > 0.001) throw new Error("Font change reused stale text measurements");
      style.destroy();
    }
  }
}
