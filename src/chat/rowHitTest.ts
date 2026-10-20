import { lineColToIndex, wrapLineAtY, wrapLineOriginX, type WrapLine, type WrapOptions, type WrapEmote } from "./wrap.ts";
export type Bounds={x:number;y:number;w:number;h:number};
export const inside=(bounds:Bounds|null,x:number,y:number):boolean=>!!bounds && x>=bounds.x && x<bounds.x+bounds.w && y>=bounds.y && y<bounds.y+bounds.h;
export type BodyHitRow={systemCloudBounds:(Bounds & {lineHeight:number;fontSize:number})|null;body:{y:number};replyRows:number;wrapLineHeights:number[];wrapLines:WrapLine[];bodyIndent:number;bodyContIndent:number;bodyRaw:string;spansRaw:WrapEmote[]};
/** Maps painted row geometry back to a UTF-16 source index for links and mentions. */
export function bodyIndexAt(row:BodyHitRow,x:number,y:number,options:{lineHeight:number;fontSize:number;bodyHeight:()=>number;wrapOptions:(cloud:boolean,fontSize:number)=>WrapOptions}):number|null {
 const cloud=row.systemCloudBounds;
 if(cloud && !inside(cloud,x,y))return null;
 const lineHeight=cloud?.lineHeight??options.lineHeight;
 const contentY=cloud?row.body.y:row.replyRows*options.lineHeight;
 const endY=!cloud && row.wrapLineHeights.length>0?contentY+options.bodyHeight():contentY+row.wrapLines.length*lineHeight;
 if(y<contentY || y>=endY)return null;
 const line=!cloud && row.wrapLineHeights.length>0?wrapLineAtY(row.wrapLineHeights,y-contentY):Math.floor((y-contentY)/lineHeight);
 if(line<0 || line>=row.wrapLines.length)return null;
 const origin=wrapLineOriginX(row.bodyIndent,line,row.bodyContIndent);
 if(x<origin)return null;
 return lineColToIndex(row.bodyRaw,row.wrapLines,line,x-origin,row.spansRaw,options.wrapOptions(!!cloud,cloud?.fontSize??options.fontSize));
}
