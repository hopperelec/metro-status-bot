const NETWORK_JSON = {
    APT_1: [
        "CAL_1"
    ],
    APT_2: [
        "CAL_1"
    ],
    CAL_1: [
        "BFT_1"
    ],
    CAL_2: [
        "APT_1",
        "APT_2"
    ],
    BFT_1: [
        "KSP_1"
    ],
    BFT_2: [
        "CAL_2"
    ],
    KSP_1: [
        "FAW_1"
    ],
    KSP_2: [
        "BFT_2",
        "FAW_1"
    ],
    FAW_1: [
        "WBR_1"
    ],
    FAW_2: [
        "KSP_2"
    ],
    WBR_1: [
        "RGC_1"
    ],
    WBR_2: [
        "FAW_2"
    ],
    RGC_1: [
        "SGF_1",
        "RGC_2"
    ],
    RGC_2: [
        "WBR_2",
        "RGC_1"
    ],
    SJM_1: [
        "MMT_3"
    ],
    SJM_2: [
        "MMT_3"
    ],
    MMT_3: [
        "MAN_1"
    ],
    MMT_4: [
        "SJM_1",
        "SJM_2"
    ],
    MAN_1: [
        "BYK_1",
        "MAN_2",
    ],
    MAN_2: [
        "MMT_4",
        "MAN_1"
    ],
    BYK_1: [
        "CRD_1"
    ],
    BYK_2: [
        "MAN_1",
        "MAN_2"
    ],
    CRD_1: [
        "WKG_1"
    ],
    CRD_2: [
        "BYK_2"
    ],
    WKG_1: [
        "WSD_1",
        "WSD_2"
    ],
    WKG_2: [
        "CRD_2",
        "CRD_1"
    ],
    WSD_1: [
        "HDR_1"
    ],
    WSD_2: [
        "WKG_2",
        "WSD_1"
    ],
    HDR_1: [
        "HOW_1"
    ],
    HDR_2: [
        "WSD_2"
    ],
    HOW_1: [
        "PCM_1",
        "HDJ"
    ],
    HOW_2: [
        "HDR_2",
        "HDJ"
    ],
    PCM_1: [
        "MWL_1"
    ],
    PCM_2: [
        "HOW_2"
    ],
    MWL_1: [
        "NSH_1",
        "NSH_2"
    ],
    MWL_2: [
        "PCM_2"
    ],
    NSH_1: [
        "TYN_1",
        "NSH_2"
    ],
    NSH_2: [
        "MWL_2",
        "NSH_1"
    ],
    TYN_1: [
        "CUL_1"
    ],
    TYN_2: [
        "NSH_2",
        "CUL_1",
        "TYN_1"
    ],
    CUL_1: [
        "WTL_1"
    ],
    CUL_2: [
        "TYN_2"
    ],
    WTL_1: [
        "MSN_1",
        "MSN_2"
    ],
    WTL_2: [
        "CUL_2"
    ],
    MSN_1: [
        "WMN_1",
        "MSN_2",
        "WTL_1"
    ],
    MSN_2: [
        "WTL_2",
        "MSN_1",
        "WTL_1"
    ],
    WMN_1: [
        "SMR_1",
        "SMR_2"
    ],
    WMN_2: [
        "MSN_2"
    ],
    SMR_1: [
        "NPK_1"
    ],
    SMR_2: [
        "WMN_2"
    ],
    NPK_1: [
        "PMV_1"
    ],
    NPK_2: [
        "SMR_2"
    ],
    PMV_1: [
        "BTN_1",
        "BTN_2"
    ],
    PMV_2: [
        "NPK_2"
    ],
    BTN_1: [
        "FLE_1"
    ],
    BTN_2: [
        "PMV_2"
    ],
    FLE_1: [
        "LBN_1"
    ],
    FLE_2: [
        "BTN_2"
    ],
    LBN_1: [
        "SGF_1",
        "SGF_2",
        "GEJ"
    ],
    LBN_2: [
        "FLE_2"
    ],
    SGF_1: [
        "ILF_1",
        "SGF_2"
    ],
    SGF_2: [
        "LBN_2",
        "RGC_2",
        "SGF_1"
    ],
    ILF_1: [
        "WJS_1"
    ],
    ILF_2: [
        "SGF_2"
    ],
    WJS_1: [
        "JES_1",
    ],
    WJS_2: [
        "ILF_2",
    ],
    JES_1: [
        "HAY_1",
        "WJS_1",
        "WJS_2"
    ],
    JES_2: [
        "WJS_2"
    ],
    HAY_1: [
        "MMT_1"
    ],
    HAY_2: [
        "JES_2",
        "MMT_1"
    ],
    MMT_1: [
        "CEN_1",
        "HAY_2"
    ],
    MMT_2: [
        "HAY_2"
    ],
    CEN_1: [
        "GHD_1"
    ],
    CEN_2: [
        "MMT_2"
    ],
    GHD_1: [
        "GST_1"
    ],
    GHD_2: [
        "CEN_2"
    ],
    GST_1: [
        "FEL_1",
        "GHD_2"
    ],
    GST_2: [
        "GHD_2"
    ],
    FEL_1: [
        "HTH_1",
        "HTH_2"
    ],
    FEL_2: [
        "GST_2"
    ],
    HTH_1: [
        "PLW_1"
    ],
    HTH_2: [
        "FEL_2"
    ],
    PLW_1: [
        "HEB_1",
        "PJC_1",
        "PLW_2"
    ],
    PLW_2: [
        "HTH_2",
        "PLW_1"
    ],
    HEB_1: [
        "JAR_1",
        "PLW_2",
        "PLW_1"
    ],
    HEB_2: [
        "PLW_2",
        "PLW_1"
    ],
    JAR_1: [
        "BDE_1",
        "BDE_2"
    ],
    JAR_2: [
        "HEB_2"
    ],
    BDE_1: [
        "SMD_1",
        "JAR_2"
    ],
    BDE_2: [
        "JAR_2"
    ],
    SMD_1: [
        "TDK_1"
    ],
    SMD_2: [
        "BDE_2"
    ],
    TDK_1: [
        "CHI_1"
    ],
    TDK_2: [
        "SMD_2"
    ],
    CHI_1: [
        "SSS_2"
    ],
    CHI_2: [
        "TDK_2"
    ],
    SSS_2: [
        "CHI_2",
        "SSS_1"
    ],
    SSS_1: [
        "SSS_2"
    ],
    PJC_1: [
        "FGT_1",
        "PLW_2"
    ],
    PJC_2: [
        "PLW_2"
    ],
    FGT_1: [
        "BYW_1"
    ],
    FGT_2: [
        "PJC_1",
        "PJC_2"
    ],
    BYW_1: [
        "EBO_1",
        "FGT_2"
    ],
    BYW_2: [
        "FGT_2"
    ],
    EBO_1: [
        "SBN_1",
        "BYW_2",
        "BYW_1"
    ],
    EBO_2: [
        "BYW_2",
        "BYW_1",
        "FGT_2" // The Pop app doesn't usually show trains at BYW_2, instead skipping to FGT_2
    ],
    SBN_1: [
        "SFC_1"
    ],
    SBN_2: [
        "EBO_2"
    ],
    SFC_1: [
        "MSP_1"
    ],
    SFC_2: [
        "SBN_2"
    ],
    MSP_1: [
        "SUN_1",
        "SUN_2",
        "SUN_3",
        "SUN_4",
        "SFC_2"
    ],
    MSP_2: [
        "SFC_2"
    ],
    SUN_1: [
        "PLI_1",
        "PLI_2",
        "SUN_2",
        "MSP_2"
    ],
    SUN_2: [
        "PLI_1",
        "PLI_2",
        "SUN_1",
        "MSP_2"
    ],
    SUN_3: [
        "MSP_2",
        "SUN_4",
        "PLI_1",
        "PLI_2"
    ],
    SUN_4: [
        "MSP_2",
        "SUN_3",
        "PLI_1",
        "PLI_2"
    ],
    PLI_1: [
        "UNI_1"
    ],
    PLI_2: [
        "SUN_3",
        "SUN_4"
    ],
    UNI_1: [
        "MLF_1"
    ],
    UNI_2: [
        "PLI_2"
    ],
    MLF_1: [
        "PAL_1"
    ],
    MLF_2: [
        "UNI_2"
    ],
    PAL_1: [
        "SHL_1",
        "SHL_2",
        "PAL_2" // The Pop app doesn't usually show trains at SHL, instead skipping to PAL_2
    ],
    PAL_2: [
        "MLF_2"
    ],
    SHL_1: [
        "PAL_2",
        "SHL_2"
    ],
    SHL_2: [
        "PAL_2",
        "SHL_1"
    ]
};

const JJC_NETWORK: Record<string, Set<string>> = {
    MAN_1: new Set(["WJS_1", "WJS_2", "JES_1"]),
    WJS_1: new Set(["MAN_1", "WJS_2", "JES_1"]),
    WJS_2: new Set(["MAN_1", "WJS_1", "JES_1"]),
    JES_1: new Set(["MAN_1", "WJS_1", "WJS_2"])
};

const network: Record<string, Set<string>> = {};
for (const [from, toList] of Object.entries(NETWORK_JSON)) {
    network[from as string] = new Set(toList);
}

export default network;

export function isAdjacent(from: string, to: string): boolean {
    const adjacentLocations = network[from];
    if (!adjacentLocations) return false;
    return adjacentLocations.has(to);
}

export function isJesmondJunction(from: string, to: string): boolean {
    const adjacentLocations = JJC_NETWORK[from];
    if (!adjacentLocations) return false;
    return adjacentLocations.has(to);
}
