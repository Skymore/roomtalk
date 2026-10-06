/*
MIT License

Copyright (c) 2026 OpenMuse contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Ported from CopilotKit/OpenMuse 73a714963b57e5cd1747fd3fbc6833e09a36b81a.
*/
import type {RoomStore} from '../../repositories/store';
// OpenMuse record-store contract, scoped to the personal computer tables.
export class Store {
  constructor(private readonly rooms:RoomStore){}
  async get<T>(owner:string,kind:string,id:string):Promise<T|null>{return (await this.rooms.readPersonalComputerRecords!(owner,kind,id))[0]?.data as T ?? null;}
  async list<T>(owner:string,kind:string):Promise<T[]>{return (await this.rooms.readPersonalComputerRecords!(owner,kind)).map(row=>row.data as T);}
  async put<T extends {id:string}>(owner:string,kind:string,value:T):Promise<T>{const saved=await this.rooms.putPersonalComputerRecord!(owner,kind,value.id,value as Record<string,unknown>);return saved!.data as T;}
  async insertIfAbsent<T extends {id:string}>(owner:string,kind:string,value:T):Promise<T|null>{const saved=await this.rooms.putPersonalComputerRecord!(owner,kind,value.id,value as Record<string,unknown>,true);return saved?.data as T ?? null;}
  async compareAndSwap<T>(owner:string,kind:string,id:string,expected:Record<string,unknown>,patch:Record<string,unknown>):Promise<T|null>{const saved=await this.rooms.patchPersonalComputerRecord!(owner,kind,id,expected,patch);return saved?.data as T ?? null;}
}
