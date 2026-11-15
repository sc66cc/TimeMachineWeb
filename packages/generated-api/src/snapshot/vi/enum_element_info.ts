import type { ViEnum32 } from "./enum32";

export class EnumElementInfo
{
	readonly Value: number;
	readonly Name: string;
	readonly Desc: string;
	readonly Key: string;
	//
	constructor(value: number, name: string, desc?: string, key?: string)
	{
		this.Value = value;
		this.Name = name;
		this.Desc = desc ? desc : name;
		this.Key = key ? key : name;
	}
	//
}

export class EnumInfo
{
	static readonly None = new EnumElementInfo(0, "None", "None", "None");
	//
	static Has(list: Array<EnumElementInfo>, value: ViEnum32<any>): boolean
	{
		for (let iter = 0, end = list.length; iter < end; ++iter)
		{
			const iterInfo = list[iter]!;
			if (iterInfo.Value == value.Value)
			{
				return true;
			}
		}
		return false;
	}
	//
	static Get(list: Array<EnumElementInfo>, value: ViEnum32<any>, defaultValue?: EnumElementInfo): EnumElementInfo
	{
		for (let iter = 0, end = list.length; iter < end; ++iter)
		{
			const iterInfo = list[iter]!;
			if (iterInfo.Value == value.Value)
			{
				return iterInfo;
			}
		}
		//
		if (defaultValue)
		{
			return defaultValue;
		}
		//
		if (list.length > 0)
		{
			return list[0]!;
		}
		//
		return EnumInfo.None;
	}
	//
	static GetByKey(list: Array<EnumElementInfo>, key: string, defaultValue?: EnumElementInfo): EnumElementInfo
	{
		for (let iter = 0, end = list.length; iter < end; ++iter)
		{
			const iterInfo = list[iter]!;
			if (iterInfo.Key == key)
			{
				return iterInfo;
			}
		}
		//
		if (defaultValue)
		{
			return defaultValue;
		}
		//
		if (list.length > 0)
		{
			return list[0]!;
		}
		//
		return EnumInfo.None;
	}
}
