#include <iostream>
#include <stdlib.h>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("Map0224.lmu", "");
    for (const auto& ev : map->events) {
        for (const auto& page : ev.pages) {
            if (page.trigger == 3 || page.trigger == 4) {
                std::cout << "Event ID: " << ev.ID << " (X: " << ev.x << ", Y: " << ev.y << ") Trigger: " << page.trigger << "\n";
                for (const auto& cmd : page.event_commands) {
                    if (cmd.code == 10810 || cmd.code == 10840) {
                        std::cout << "    Code " << cmd.code << " Params: ";
                        for (int p : cmd.parameters) std::cout << p << " ";
                        std::cout << "\n";
                    }
                }
            }
        }
    }
    exit(0);
}
