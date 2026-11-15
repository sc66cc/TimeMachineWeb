
export class ViMask
{
	public static HasAny(value: number, mask: number): boolean
	{
		return ((value & mask) != 0);
	}
	//
	public static HasAll(value: number, mask: number): boolean
	{
		return ((value & mask) == mask);
	}
	//
	public static Add(value: number, mask: number): number
	{
		return value | mask;
	}
	//
	public static AddEx(value: number, maskStart: number, maskCount: number, maskValue:number): number
	{
		const mask = (1 << (maskStart + maskCount)) - (1 << maskStart);
		return value | (mask & (maskValue << maskStart));
	}
	//
	public static Del(value: number, mask: number): number
	{
		return value & ~mask;
	}
	//
	public static Set(value: number, maskStart: number, maskCount: number, maskValue: number): number
	{
		const mask = (1 << (maskStart + maskCount)) - (1 << maskStart);
		value  &= ~mask;//Del
		return value | (mask & (maskValue << maskStart));//AddEx
	}
	//
	public static Value(value: number, mask: number): number
	{
		return (value & mask);
	}
	//
	public static ValueEx(value: number, maskStart: number, maskCount: number): number
	{
		return (value & ((1 << (maskStart + maskCount)) - (1 << maskStart))) >> maskStart;
	}
	//
	public static Enter(oldValue: number, newValue: number, mask: number): boolean
	{
		return ((oldValue & mask) == 0) && ((newValue & mask) != 0);//(ViMask.HasAny(oldValue, mask) == false) && (ViMask.HasAny(newValue, mask) == true);
	}
	//
	public static Exit(oldValue: number, newValue: number, mask: number): boolean
	{
		return ((oldValue & mask) != 0) && ((newValue & mask) == 0);//(ViMask.HasAny(oldValue, mask) == true) && (ViMask.HasAny(newValue, mask) == false);
	}
	//
	public static Mask(value: number): number
	{
		return 1 << value;
	}
}
