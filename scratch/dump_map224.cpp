#include <iostream>
#include <stdlib.h>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("scratch/Map0224.lmu", "");
    if (!map) {
        std::cout << "Failed to load Map0224.lmu\n";
        exit(1);
    }
    for (const auto& ev : map->events) {
        for (const auto& page : ev.pages) {
            for (const auto& cmd : page.event_commands) {
                if (cmd.code == 10810 || cmd.code == 10820 || cmd.code == 10830 || cmd.code == 10840) {
                    std::cout << "Event ID: " << ev.ID << " Code: " << cmd.code << " Params: ";
                    for (int p : cmd.parameters) std::cout << p << " ";
                    std::cout << "\n";
                }
            }
        }
    }
    exit(0);
}
