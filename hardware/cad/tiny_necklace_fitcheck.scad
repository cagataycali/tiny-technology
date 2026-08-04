// fit-check: the ACTUAL ABX00051 board (vendor STL) seated inside the split
// case. Board coords: STL PCB spans x/y 0..22.86 with PCB TOP at z=0 →
// center it and seat PCB top at cav_z0+below+pcb_t = 5.646.
use <tiny_necklace_split.scad>

mode = "face"; // ["face", "iso", "open"]
seat = 1.3 + 3.4 + 0.946;

module board(){
    color("#2f7d32") translate([-11.43, -11.43, seat])
        import("NiclaVision.stl");
}

if (mode == "face"){          // straight-on: holes must land on lens/mic/ToF
    board();
    color("#0078BF", 0.55) { tray(); door(); }
}
if (mode == "iso"){
    board();
    color("#0078BF") tray();
    color("#0078BF", 0.45) door();
}
if (mode == "open"){          // tray + board, no door
    board();
    color("#0078BF") tray();
}
