import { ViMask } from "./mask";

export class ViMask32<T = void>
{
	Value: number;
	//
	constructor(value: number = 0)
	{
		this.Value = value;
	}
	//
	Add(mask: number): void
	{
		this.Value = ViMask.Add(this.Value, mask);
	}
	//
	Del(mask: number): void
	{
		this.Value = ViMask.Del(this.Value, mask);
	}
	//
	HasAny(mask: number): boolean
	{
		return ViMask.HasAny(this.Value, mask);
	}
	//
	HasAll(mask: number): boolean
	{
		return ViMask.HasAll(this.Value, mask);
	}
}