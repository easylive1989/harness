// src/shared/images.ts
// 使用者訊息附加的圖片：renderer 與 main 共用的格式與限制

/** Claude API 支援的圖片格式 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

/** 單張圖片上限（Claude API 的限制） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 每則訊息最多幾張 */
export const MAX_IMAGES = 10

/** 送出時附加的圖片：data 是 base64（不含 `data:` 前綴） */
export interface ImageInput {
  mediaType: ImageMediaType
  data: string
  name?: string
}

/** 已存檔的圖片（任務資料夾的 attachments/ 裡），時間軸與任務只記這個 */
export interface ImageRef {
  id: string
  mediaType: ImageMediaType
  name?: string
}

export const isImageMediaType = (v: unknown): v is ImageMediaType =>
  IMAGE_MEDIA_TYPES.includes(v as ImageMediaType)

/** 存檔用的副檔名 */
export const imageExt = (t: ImageMediaType) =>
  t === 'image/jpeg' ? 'jpg' : t.slice('image/'.length)

/** base64 字串解碼後的位元組數 */
export const base64Bytes = (data: string) =>
  Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
