#include <iostream>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main(int argc, char** argv) {
    auto map = lcf::LMU_Reader::Load("ynodesktop/scratch/maps/Map0224.lmu", "");
    for (const auto& ev : map->events) {
        if (ev.x == 5 && ev.y == 0) { // Maybe door is at 5,0? Let's just dump the door! Wait, where is the door?
            // Actually, let's just dump ALL events!
        }
        std::cout << "Event ID: " << ev.ID << " Name: " << ev.name << " X: " << ev.x << " Y: " << ev.y << "\n";
        for (const auto& page : ev.pages) {
            for (const auto& cmd : page.event_commands) {
                if (cmd.code != 10) { // 10 is empty line
                    std::cout << "  Code: " << cmd.code << " Params: ";
                    for (int p : cmd.parameters) std::cout << p << " ";
                    std::cout << "\n";
                }
            }
        }
    }
    return 0;
}
