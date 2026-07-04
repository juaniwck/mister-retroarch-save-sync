/*
 * mister-retroarch-save-sync
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Bundles conversion logic from save-file-converter
 * (https://github.com/euan-forrester/save-file-converter), GPL-3.0.
 */

export { default as MisterNesSaveData } from '../vendor/save-file-converter/save-formats/Mister/Nes';
export { default as MisterSnesSaveData } from '../vendor/save-file-converter/save-formats/Mister/Snes';
export { default as MisterGameboySaveData } from '../vendor/save-file-converter/save-formats/Mister/Gameboy';
export { default as MisterGameboyAdvanceSaveData } from '../vendor/save-file-converter/save-formats/Mister/GameboyAdvance';
export { default as MisterGenesisSaveData } from '../vendor/save-file-converter/save-formats/Mister/Genesis';
export { default as MisterSmsSaveData } from '../vendor/save-file-converter/save-formats/Mister/Sms';
export { default as MisterPcEngineSaveData } from '../vendor/save-file-converter/save-formats/Mister/PcEngine';
export { default as MisterPs1SaveData } from '../vendor/save-file-converter/save-formats/Mister/Ps1';
export { default as MisterN64CartSaveData } from '../vendor/save-file-converter/save-formats/Mister/N64Cart';
export { default as MisterN64MempackSaveData } from '../vendor/save-file-converter/save-formats/Mister/N64Mempack';
export { default as N64MempackSaveData } from '../vendor/save-file-converter/save-formats/N64/Mempack';
export { default as MisterSegaCdSaveData } from '../vendor/save-file-converter/save-formats/Mister/SegaCd';
export { default as MisterSegaSaturnSaveData } from '../vendor/save-file-converter/save-formats/Mister/SegaSaturn';
export { default as SegaSaturnSaveData } from '../vendor/save-file-converter/save-formats/SegaSaturn/SegaSaturn';
export { default as SegaCdUtil } from '../vendor/save-file-converter/util/SegaCd';
export { default as N64Util } from '../vendor/save-file-converter/util/N64';
export { default as PcEngineUtil } from '../vendor/save-file-converter/util/PcEngine';
export { default as GenesisUtil } from '../vendor/save-file-converter/util/Genesis';
export { default as PaddingUtil } from '../vendor/save-file-converter/util/Padding';

// Constant used by discriminators: the smallest SRAM save save-file-converter
// recognizes (below this threshold a save is treated as EEPROM / small).
export const GenesisSmallestSramSize = 512;
